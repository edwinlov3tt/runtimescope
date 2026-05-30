//! Recon tools: read stored `recon_*` events (page metadata, design tokens,
//! layout tree, fonts, accessibility, computed styles, element snapshot, asset
//! inventory) and shape the most-recent capture. `get_style_diff` has no stored
//! event type in the Rust collector yet, so it is a registered stub.

use crate::tools::envelope;
use crate::Mcp;
use rmcp::{handler::server::wrapper::Parameters, model::CallToolResult, tool, tool_router, ErrorData};
use serde::Deserialize;
use serde_json::{json, Value};

/// Pick the most-recent event (events_by_type returns newest-first) whose `url`
/// field contains the optional substring filter.
fn pick_by_url(events: &[Value], url: Option<&str>) -> Option<Value> {
    match url {
        None => events.first().cloned(),
        Some(needle) => events
            .iter()
            .find(|e| {
                e.get("url")
                    .and_then(|u| u.as_str())
                    .is_some_and(|u| u.contains(needle))
            })
            .cloned(),
    }
}

impl Mcp {
    /// Best-effort: when `force_refresh` is set, ask the connected SDK to run a
    /// fresh recon scan via the command channel. Failures are ignored — the tool
    /// falls through to whatever is already in the store (matches the TS behavior).
    async fn recon_refresh(&self, force: bool, command: &str, params: Value) {
        if !force {
            return;
        }
        let session = self
            .store
            .sessions()
            .await
            .into_iter()
            .find(|s| s.is_connected);
        if let Some(session) = session {
            let _ = self.hub.send_command(&session.session_id, command, params).await;
        }
    }

    /// The URL of the most-recently scanned page, derived from stored `recon_*`
    /// events (scan_website ingests them with a `url`). Mirrors Node's
    /// `scanner.getLastScannedUrl()` — global, not project-scoped.
    async fn last_scanned_url(&self) -> Option<String> {
        for ty in [
            "recon_metadata",
            "recon_layout_tree",
            "recon_design_tokens",
            "recon_accessibility",
            "recon_fonts",
            "recon_asset_inventory",
        ] {
            let events = self.store.events_by_type(ty, None).await;
            if let Some(url) = events.first().and_then(|e| e.get("url")).and_then(|u| u.as_str()) {
                return Some(url.to_string());
            }
        }
        None
    }

    /// Live selector capture via the recon sidecar (ADR-0007) — the fallback when
    /// nothing is stored for a selector but a page has been scanned. Builds a
    /// synthetic `recon_*` event from the sidecar's raw result, caches it under
    /// `project`, and returns it. Mirrors Node's `scanner.queryComputedStyles` /
    /// `queryElementSnapshot` → synthetic-event path. Returns `None` if the sidecar
    /// is unavailable or finds nothing (caller falls through to the no-data hint).
    async fn recon_live_capture(
        &self,
        method: &str,
        event_type: &str,
        url: &str,
        params: Value,
        project: &str,
    ) -> Option<Value> {
        let raw = crate::sidecar::call_sidecar(method, params).await.ok()?;
        let obj = raw.as_object()?.clone();
        let now = crate::tools::now_ms();
        let mut ev = obj;
        ev.insert("eventId".into(), json!(format!("evt-scan-{event_type}-{now}")));
        ev.insert("sessionId".into(), json!(format!("scan-{now}")));
        ev.insert("timestamp".into(), json!(now));
        ev.insert("eventType".into(), json!(event_type));
        ev.insert("url".into(), json!(url));
        let event = Value::Object(ev);
        // Best-effort cache so repeat queries hit the store (Node stores it too).
        let _ = self.store.add_batch(project.to_string(), vec![event.clone()]).await;
        Some(event)
    }
}

/// Extract the raw numeric `timestamp` (epoch ms) from a stored event. Recon
/// tools surface `metadata.timeRange` as `{from: ts, to: ts}` using the raw
/// number (matching the TS source — these are not ISO-formatted).
fn event_ts(event: &Value) -> i64 {
    event.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0)
}

/// The "no data" envelope shared by every recon read tool.
fn no_data(summary: &str, missing_type: &str, project_id: Option<String>) -> CallToolResult {
    envelope(json!({
        "summary": summary,
        "data": null,
        "issues": [format!("No {missing_type} events found in the event store")],
        "metadata": { "timeRange": { "from": 0, "to": 0 }, "eventCount": 0, "sessionId": null, "projectId": project_id },
    }))
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PageMetadataArgs {
    /// Scope results to one project (the proj_xxx from .runtimescope/config.json).
    project_id: Option<String>,
    /// Filter by URL substring.
    url: Option<String>,
    /// Send a recon_scan command to the extension to capture fresh data.
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct DesignTokensArgs {
    project_id: Option<String>,
    /// Filter by URL substring.
    url: Option<String>,
    /// Return only a specific token category (all|colors|typography|spacing|custom_properties|shadows).
    category: Option<String>,
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct LayoutTreeArgs {
    project_id: Option<String>,
    /// CSS selector to scope the tree (e.g., "nav", ".hero", "main"). Omit for full page.
    selector: Option<String>,
    /// Maximum depth of the tree to return (default 10).
    max_depth: Option<u64>,
    /// Filter by URL substring.
    url: Option<String>,
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct FontInfoArgs {
    project_id: Option<String>,
    /// Filter by URL substring.
    url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AccessibilityArgs {
    project_id: Option<String>,
    /// Filter by URL substring.
    url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ComputedStylesArgs {
    project_id: Option<String>,
    /// CSS selector to query (e.g., ".btn-primary", "nav > ul > li").
    selector: String,
    /// Property group to return (all|colors|typography|spacing|layout|borders|visual).
    properties: Option<String>,
    /// Specific CSS property names to return (overrides the properties group).
    specific_properties: Option<Vec<String>>,
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ElementSnapshotArgs {
    project_id: Option<String>,
    /// CSS selector for the root element (e.g., ".card", "#hero").
    selector: String,
    /// How many levels deep to capture children (default 5).
    depth: Option<u64>,
    force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AssetInventoryArgs {
    project_id: Option<String>,
    /// Filter by asset category (all|images|svg|sprites|icon_fonts).
    category: Option<String>,
    /// Filter by page URL substring.
    url: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StyleDiffArgs {
    project_id: Option<String>,
    /// CSS selector for the source/original element.
    source_selector: String,
    /// CSS selector for the target/recreation element.
    target_selector: String,
    /// "visual" (default) or "all".
    properties: Option<String>,
    /// Specific CSS property names to compare (overrides properties group).
    specific_properties: Option<Vec<String>>,
}

#[tool_router(router = recon_router, vis = "pub")]
impl Mcp {
    #[tool(description = "Get page metadata and tech stack detection for the current page. Returns URL, viewport, meta tags, detected framework/UI library/build tool/hosting, external stylesheets and scripts. Requires the RuntimeScope extension to be connected.")]
    async fn get_page_metadata(
        &self,
        Parameters(args): Parameters<PageMetadataArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.recon_refresh(
            args.force_refresh.unwrap_or(false),
            "recon_scan",
            json!({ "categories": ["recon_metadata"] }),
        )
        .await;
        let events = self.store.events_by_type("recon_metadata", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No page metadata captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_metadata",
                args.project_id,
            ));
        };

        let title = event.get("title").and_then(|v| v.as_str());
        let url = event.get("url").and_then(|v| v.as_str()).unwrap_or("");
        let stylesheets = event.get("externalStylesheets").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let scripts = event.get("externalScripts").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);

        let mut issues: Vec<String> = Vec::new();
        let has_viewport = event
            .get("metaTags")
            .and_then(|m| m.get("viewport"))
            .is_some();
        if !has_viewport {
            issues.push("No viewport meta tag detected".to_string());
        }

        Ok(envelope(json!({
            "summary": format!("Page: {}. {stylesheets} stylesheets, {scripts} scripts.", title.unwrap_or(url)),
            "data": {
                "url": event.get("url"),
                "title": event.get("title"),
                "viewport": event.get("viewport"),
                "documentLang": event.get("documentLang"),
                "metaTags": event.get("metaTags"),
                "techStack": event.get("techStack"),
                "externalStylesheets": event.get("externalStylesheets"),
                "externalScripts": event.get("externalScripts"),
                "preloads": event.get("preloads"),
            },
            "issues": issues,
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Extract the design system from the current page: CSS custom properties (--variables), color palette, typography scale, spacing scale, border radii, box shadows, and CSS architecture detection. Essential for matching a site's visual style when recreating UI.")]
    async fn get_design_tokens(
        &self,
        Parameters(args): Parameters<DesignTokensArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.recon_refresh(
            args.force_refresh.unwrap_or(false),
            "recon_scan",
            json!({ "categories": ["recon_design_tokens"] }),
        )
        .await;
        let events = self.store.events_by_type("recon_design_tokens", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No design tokens captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_design_tokens",
                args.project_id,
            ));
        };

        let category = args.category.as_deref().unwrap_or("all");
        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);

        let arr_len = |key: &str| event.get(key).and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let custom_props = arr_len("customProperties");
        let colors = arr_len("colors");
        let typography = arr_len("typography");
        let spacing = arr_len("spacing");
        let css_arch = event.get("cssArchitecture").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();

        let mut issues: Vec<String> = Vec::new();
        if custom_props == 0 {
            issues.push("No CSS custom properties (--variables) found. The site may use hardcoded values instead of design tokens.".to_string());
        }
        if colors > 30 {
            issues.push(format!("{colors} unique colors found — this may indicate an inconsistent color system."));
        }
        if typography > 15 {
            issues.push(format!("{typography} unique typography combos found — may indicate inconsistent type scale."));
        }

        let mut data = serde_json::Map::new();
        if category == "all" || category == "custom_properties" {
            data.insert("customProperties".into(), event.get("customProperties").cloned().unwrap_or(Value::Null));
        }
        if category == "all" || category == "colors" {
            data.insert("colors".into(), event.get("colors").cloned().unwrap_or(Value::Null));
        }
        if category == "all" || category == "typography" {
            data.insert("typography".into(), event.get("typography").cloned().unwrap_or(Value::Null));
        }
        if category == "all" || category == "spacing" {
            data.insert("spacing".into(), event.get("spacing").cloned().unwrap_or(Value::Null));
        }
        if category == "all" || category == "shadows" {
            data.insert("borderRadii".into(), event.get("borderRadii").cloned().unwrap_or(Value::Null));
            data.insert("boxShadows".into(), event.get("boxShadows").cloned().unwrap_or(Value::Null));
        }
        if category == "all" {
            data.insert("cssArchitecture".into(), event.get("cssArchitecture").cloned().unwrap_or(Value::Null));
            data.insert("classNamingPatterns".into(), event.get("classNamingPatterns").cloned().unwrap_or(Value::Null));
            data.insert("sampleClassNames".into(), event.get("sampleClassNames").cloned().unwrap_or(Value::Null));
        }

        Ok(envelope(json!({
            "summary": format!("{custom_props} CSS variables, {colors} colors, {typography} type combos, {spacing} spacing values, CSS architecture: {css_arch}."),
            "data": data,
            "issues": issues,
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get the DOM structure with layout information: element tags, classes, bounding rects, display mode (flex/grid/block), flex/grid properties, position, and z-index. Optionally scoped to a CSS selector. Essential for understanding page structure when recreating UI.")]
    async fn get_layout_tree(
        &self,
        Parameters(args): Parameters<LayoutTreeArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.recon_refresh(
            args.force_refresh.unwrap_or(false),
            "recon_layout_tree",
            json!({ "selector": args.selector, "maxDepth": args.max_depth.unwrap_or(10) }),
        )
        .await;
        let events = self.store.events_by_type("recon_layout_tree", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No layout tree captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_layout_tree",
                args.project_id,
            ));
        };

        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);
        let total_elements = event.get("totalElements").and_then(|v| v.as_u64()).unwrap_or(0);
        let max_depth = event.get("maxDepth").and_then(|v| v.as_u64()).unwrap_or(0);
        let vw = event.get("viewport").and_then(|v| v.get("width")).and_then(|v| v.as_u64()).unwrap_or(0);
        let vh = event.get("viewport").and_then(|v| v.get("height")).and_then(|v| v.as_u64()).unwrap_or(0);
        let scoped = args.selector.as_ref().map(|s| format!(" Scoped to: {s}.")).unwrap_or_default();

        let tree = event.get("tree").cloned().unwrap_or(Value::Null);
        let flex_count = count_by_display(&tree, "flex");
        let grid_count = count_by_display(&tree, "grid");

        Ok(envelope(json!({
            "summary": format!("Layout tree: {total_elements} elements, max depth {max_depth}. {flex_count} flex containers, {grid_count} grid containers. Viewport: {vw}x{vh}.{scoped}"),
            "data": {
                "viewport": event.get("viewport"),
                "scrollHeight": event.get("scrollHeight"),
                "rootSelector": args.selector.clone().or_else(|| event.get("rootSelector").and_then(|v| v.as_str()).map(String::from)),
                "tree": event.get("tree"),
                "totalElements": total_elements,
                "maxDepth": max_depth,
            },
            "issues": [],
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get typography details for the current page: @font-face declarations, font families actually used in computed styles, icon fonts with glyph usage, and font loading strategy. Critical for matching typography when recreating UI.")]
    async fn get_font_info(
        &self,
        Parameters(args): Parameters<FontInfoArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("recon_fonts", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No font data captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_fonts",
                args.project_id,
            ));
        };

        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);
        let font_faces = event.get("fontFaces").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let fonts_used = event.get("fontsUsed").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let icon_fonts = event.get("iconFonts").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0);
        let loading = event.get("loadingStrategy").and_then(|v| v.as_str()).unwrap_or("unknown");

        // Unique families used.
        let mut families: Vec<String> = Vec::new();
        for f in &fonts_used {
            if let Some(fam) = f.get("family").and_then(|v| v.as_str()) {
                if !families.iter().any(|x| x == fam) {
                    families.push(fam.to_string());
                }
            }
        }

        let mut issues: Vec<String> = Vec::new();
        if families.len() > 5 {
            issues.push(format!("{} different font families in use — may impact page load performance.", families.len()));
        }
        let missing_display = font_faces
            .iter()
            .filter(|f| f.get("display").map(|d| d.is_null() || d.as_str() == Some("")).unwrap_or(true))
            .count();
        if missing_display > 0 {
            issues.push(format!("{missing_display} @font-face rule(s) without font-display — may cause FOIT (flash of invisible text)."));
        }

        Ok(envelope(json!({
            "summary": format!("{} @font-face declarations, {} font families in use ({}), {} icon font(s). Loading: {}.",
                font_faces.len(), families.len(), families.join(", "), icon_fonts, loading),
            "data": {
                "fontFaces": event.get("fontFaces"),
                "fontsUsed": event.get("fontsUsed"),
                "iconFonts": event.get("iconFonts"),
                "loadingStrategy": event.get("loadingStrategy"),
            },
            "issues": issues,
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get the accessibility structure of the current page: heading hierarchy (h1-h6), ARIA landmarks (nav, main, aside), form fields with labels, buttons, links, and images with alt text status. Useful for ensuring UI recreations maintain proper semantic HTML and accessibility.")]
    async fn get_accessibility_tree(
        &self,
        Parameters(args): Parameters<AccessibilityArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("recon_accessibility", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No accessibility data captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_accessibility",
                args.project_id,
            ));
        };

        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);
        let arr = |key: &str| event.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let headings = arr("headings");
        let landmarks = arr("landmarks");
        let form_fields = arr("formFields");
        let buttons = arr("buttons");
        let links = arr("links");
        let images = arr("images");

        let mut issues: Vec<String> = event
            .get("issues")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|i| i.as_str().map(String::from)).collect())
            .unwrap_or_default();

        let levels: Vec<u64> = headings
            .iter()
            .filter_map(|h| h.get("level").and_then(|v| v.as_u64()))
            .collect();
        if let Some(&first) = levels.first() {
            if first != 1 {
                issues.push(format!("First heading is h{first}, not h1."));
            }
        }
        for i in 1..levels.len() {
            if levels[i] > levels[i - 1] + 1 {
                issues.push(format!(
                    "Heading level skip: h{} → h{} (missing h{}).",
                    levels[i - 1], levels[i], levels[i - 1] + 1
                ));
                break;
            }
        }

        let missing_alt = images
            .iter()
            .filter(|img| !img.get("hasAlt").and_then(|v| v.as_bool()).unwrap_or(false))
            .count();
        if missing_alt > 0 {
            issues.push(format!("{missing_alt} image(s) missing alt text."));
        }

        let unlabeled = form_fields
            .iter()
            .filter(|f| {
                let no_label = f.get("label").map(|v| v.is_null() || v.as_str() == Some("")).unwrap_or(true);
                let no_aria = f.get("ariaDescribedBy").map(|v| v.is_null() || v.as_str() == Some("")).unwrap_or(true);
                no_label && no_aria
            })
            .count();
        if unlabeled > 0 {
            issues.push(format!("{unlabeled} form field(s) without labels."));
        }

        let has_main = landmarks.iter().any(|l| l.get("role").and_then(|v| v.as_str()) == Some("main"));
        let has_nav = landmarks.iter().any(|l| l.get("role").and_then(|v| v.as_str()) == Some("navigation"));
        if !has_main {
            issues.push("No <main> landmark found.".to_string());
        }
        if !has_nav {
            issues.push("No <nav> landmark found.".to_string());
        }

        Ok(envelope(json!({
            "summary": format!("{} headings, {} landmarks, {} form fields, {} buttons, {} links, {} images. {} accessibility issue(s).",
                headings.len(), landmarks.len(), form_fields.len(), buttons.len(), links.len(), images.len(), issues.len()),
            "data": {
                "headings": event.get("headings"),
                "landmarks": event.get("landmarks"),
                "formFields": event.get("formFields"),
                "buttons": event.get("buttons"),
                "links": event.get("links"),
                "images": event.get("images"),
            },
            "issues": issues,
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Get computed CSS styles for elements matching a selector. Returns the actual resolved values the browser uses to render each element. Can filter by property group (colors, typography, spacing, layout, borders, visual) or specific property names. When multiple elements match, highlights variations between them.")]
    async fn get_computed_styles(
        &self,
        Parameters(args): Parameters<ComputedStylesArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let prop_filter: Option<Vec<String>> = args.specific_properties.clone().or_else(|| {
            property_group(args.properties.as_deref().unwrap_or("all"))
                .map(|g| g.iter().map(|s| s.to_string()).collect())
        });
        self.recon_refresh(
            args.force_refresh.unwrap_or(false),
            "recon_computed_styles",
            json!({ "selector": args.selector, "properties": prop_filter }),
        )
        .await;
        let events = self.store.events_by_type("recon_computed_styles", args.project_id.as_deref()).await;
        // Prefer an event whose selector matches, else the most recent.
        let empty_entries = |e: &Value| {
            e.get("entries").and_then(|v| v.as_array()).map(|a| a.is_empty()).unwrap_or(true)
        };
        let mut event = events
            .iter()
            .find(|e| e.get("selector").and_then(|v| v.as_str()) == Some(args.selector.as_str()))
            .or_else(|| events.first())
            .cloned()
            .filter(|e| !empty_entries(e));

        // Fallback: nothing stored for this selector, but a page was scanned →
        // capture live via the sidecar (Node's scanner.queryComputedStyles path).
        if event.is_none() {
            if let Some(url) = self.last_scanned_url().await {
                let project = args.project_id.clone().unwrap_or_else(|| url.clone());
                if let Some(synth) = self
                    .recon_live_capture(
                        "computed_styles",
                        "recon_computed_styles",
                        &url,
                        json!({ "url": url, "selector": args.selector, "properties": prop_filter }),
                        &project,
                    )
                    .await
                {
                    event = Some(synth).filter(|e| !empty_entries(e));
                }
            }
        }

        let Some(event) = event else {
            let selector = &args.selector;
            return Ok(envelope(json!({
                "summary": format!("No computed styles captured for \"{selector}\". Run scan_website first to scan a page, then query selectors on it."),
                "data": null,
                "issues": ["No computed style data available for this selector"],
                "metadata": { "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            })));
        };

        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let properties = args.properties.as_deref().unwrap_or("all");

        let group = property_group(properties);
        let raw_entries = event.get("entries").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut issues: Vec<String> = Vec::new();
        let mut total_props = 0usize;
        let mut entries: Vec<Value> = Vec::new();

        for entry in &raw_entries {
            let mut styles = entry.get("styles").and_then(|v| v.as_object()).cloned().unwrap_or_default();

            if let Some(specific) = args.specific_properties.as_ref().filter(|s| !s.is_empty()) {
                let mut filtered = serde_json::Map::new();
                for prop in specific {
                    if let Some(v) = styles.get(prop) {
                        filtered.insert(prop.clone(), v.clone());
                    }
                }
                styles = filtered;
            } else if let Some(group) = group {
                let mut filtered = serde_json::Map::new();
                for prop in group {
                    if let Some(v) = styles.get(*prop) {
                        filtered.insert((*prop).to_string(), v.clone());
                    }
                }
                styles = filtered;
            }

            total_props += styles.len();
            let variations = entry.get("variations").cloned().unwrap_or(json!([]));
            let var_count = variations.as_array().map(|a| a.len()).unwrap_or(0);
            let match_count = entry.get("matchCount").and_then(|v| v.as_u64()).unwrap_or(0);
            let sel = entry.get("selector").and_then(|v| v.as_str()).unwrap_or("");
            if var_count > 0 {
                issues.push(format!("{var_count} property variation(s) across {match_count} matching elements for \"{sel}\"."));
            }

            entries.push(json!({
                "selector": entry.get("selector"),
                "matchCount": entry.get("matchCount"),
                "styles": styles,
                "variations": variations,
            }));
        }

        let selector = &args.selector;
        let group_note = if properties != "all" { format!(" ({properties} group)") } else { String::new() };
        Ok(envelope(json!({
            "summary": format!("{} element(s) matched \"{selector}\". {total_props} CSS properties returned{group_note}.", entries.len()),
            "data": {
                "selector": selector,
                "propertyFilter": args.specific_properties.clone().map(|s| json!(s)).unwrap_or_else(|| json!(properties)),
                "entries": entries,
            },
            "issues": issues,
            "metadata": { "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Deep snapshot of a specific element and its children: structure, attributes, text content, bounding rects, and key computed styles for every node. The \"zoom in\" tool — use it when you need the full picture of a component for recreation.")]
    async fn get_element_snapshot(
        &self,
        Parameters(args): Parameters<ElementSnapshotArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        self.recon_refresh(
            args.force_refresh.unwrap_or(false),
            "recon_element_snapshot",
            json!({ "selector": args.selector, "depth": args.depth.unwrap_or(5) }),
        )
        .await;
        let events = self.store.events_by_type("recon_element_snapshot", args.project_id.as_deref()).await;
        let mut event = events
            .iter()
            .find(|e| e.get("selector").and_then(|v| v.as_str()) == Some(args.selector.as_str()))
            .or_else(|| events.first())
            .cloned();

        // Fallback: capture live via the sidecar (Node's scanner.queryElementSnapshot).
        if event.is_none() {
            if let Some(url) = self.last_scanned_url().await {
                let project = args.project_id.clone().unwrap_or_else(|| url.clone());
                event = self
                    .recon_live_capture(
                        "element_snapshot",
                        "recon_element_snapshot",
                        &url,
                        json!({ "url": url, "selector": args.selector, "depth": args.depth.unwrap_or(5) }),
                        &project,
                    )
                    .await;
            }
        }

        let Some(event) = event else {
            let selector = &args.selector;
            return Ok(envelope(json!({
                "summary": format!("No element snapshot captured for \"{selector}\". Run scan_website first to scan a page, then query selectors on it."),
                "data": null,
                "issues": ["No element snapshot data available for this selector"],
                "metadata": { "eventCount": 0, "sessionId": null, "projectId": args.project_id },
            })));
        };

        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let total_nodes = event.get("totalNodes").and_then(|v| v.as_u64()).unwrap_or(0);
        let depth = event.get("depth").and_then(|v| v.as_u64()).unwrap_or(0);
        let root = event.get("root").cloned().unwrap_or(Value::Null);
        let tag = root.get("tag").and_then(|v| v.as_str()).unwrap_or("?");
        let w = root.get("boundingRect").and_then(|r| r.get("width")).and_then(|v| v.as_f64()).unwrap_or(0.0);
        let h = root.get("boundingRect").and_then(|r| r.get("height")).and_then(|v| v.as_f64()).unwrap_or(0.0);

        let mut issues: Vec<String> = Vec::new();
        let selector = &args.selector;
        if w == 0.0 || h == 0.0 {
            issues.push(format!("Root element \"{selector}\" has zero dimensions ({w}x{h}). It may be hidden."));
        }

        Ok(envelope(json!({
            "summary": format!("Element snapshot for \"{selector}\": {total_nodes} nodes captured to depth {depth}. Root is <{tag}> at {w}x{h}px."),
            "data": {
                "selector": event.get("selector"),
                "depth": depth,
                "totalNodes": total_nodes,
                "root": root,
            },
            "issues": issues,
            "metadata": { "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Sprite-aware asset inventory for the current page. Detects standard images, inline SVGs, SVG sprite sheets, CSS background sprites (with crop coordinates), CSS mask sprites, and icon fonts (with glyph codepoints).")]
    async fn get_asset_inventory(
        &self,
        Parameters(args): Parameters<AssetInventoryArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let events = self.store.events_by_type("recon_asset_inventory", args.project_id.as_deref()).await;
        let Some(event) = pick_by_url(&events, args.url.as_deref()) else {
            return Ok(no_data(
                "No asset inventory captured yet. Ensure the RuntimeScope extension is connected and has scanned a page.",
                "recon_asset_inventory",
                args.project_id,
            ));
        };

        let category = args.category.as_deref().unwrap_or("all");
        let session_id = event.get("sessionId").cloned().unwrap_or(Value::Null);
        let ts = event_ts(&event);
        let arr = |key: &str| event.get(key).and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let images = arr("images");
        let inline_svgs = arr("inlineSVGs");
        let svg_sprites = arr("svgSprites");
        let bg_sprites = arr("backgroundSprites");
        let mask_sprites = arr("maskSprites");
        let icon_fonts = arr("iconFonts");

        let frames_sum = |sheets: &[Value]| -> usize {
            sheets.iter().map(|s| s.get("frames").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)).sum()
        };

        let mut issues: Vec<String> = Vec::new();
        let mut data = serde_json::Map::new();

        if category == "all" || category == "images" {
            data.insert("images".into(), event.get("images").cloned().unwrap_or(Value::Null));
            let missing_alt = images
                .iter()
                .filter(|img| img.get("alt").map(|v| v.is_null() || v.as_str() == Some("")).unwrap_or(true))
                .count();
            if missing_alt > 0 {
                issues.push(format!("{missing_alt} image(s) missing alt text."));
            }
            let oversized = images
                .iter()
                .filter(|img| {
                    let nat = img.get("naturalWidth").and_then(|v| v.as_f64());
                    let disp = img.get("width").and_then(|v| v.as_f64());
                    matches!((nat, disp), (Some(n), Some(d)) if d > 0.0 && n > d * 2.0)
                })
                .count();
            if oversized > 0 {
                issues.push(format!("{oversized} image(s) are significantly larger than their display size — consider resizing."));
            }
        }

        if category == "all" || category == "svg" {
            data.insert("inlineSVGs".into(), event.get("inlineSVGs").cloned().unwrap_or(Value::Null));
            data.insert("svgSprites".into(), event.get("svgSprites").cloned().unwrap_or(Value::Null));
        }

        if category == "all" || category == "sprites" {
            data.insert("backgroundSprites".into(), event.get("backgroundSprites").cloned().unwrap_or(Value::Null));
            data.insert("maskSprites".into(), event.get("maskSprites").cloned().unwrap_or(Value::Null));
            data.insert("svgSprites".into(), event.get("svgSprites").cloned().unwrap_or(Value::Null));

            let total_bg = frames_sum(&bg_sprites);
            let total_mask = frames_sum(&mask_sprites);
            let total_symbols = svg_sprites.len();
            if total_bg > 0 || total_mask > 0 || total_symbols > 0 {
                let mut parts: Vec<String> = Vec::new();
                if total_bg > 0 {
                    parts.push(format!("{total_bg} background sprite frame(s) from {} sheet(s)", bg_sprites.len()));
                }
                if total_mask > 0 {
                    parts.push(format!("{total_mask} mask sprite frame(s) from {} sheet(s)", mask_sprites.len()));
                }
                if total_symbols > 0 {
                    parts.push(format!("{total_symbols} SVG symbol(s)"));
                }
                issues.push(format!("Sprite detection: {}.", parts.join(", ")));
            }
        }

        if category == "all" || category == "icon_fonts" {
            data.insert("iconFonts".into(), event.get("iconFonts").cloned().unwrap_or(Value::Null));
            let total_glyphs: usize = icon_fonts
                .iter()
                .map(|f| f.get("glyphs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0))
                .sum();
            if total_glyphs > 0 {
                issues.push(format!("{total_glyphs} icon font glyph(s) from {} font(s) detected.", icon_fonts.len()));
            }
        }

        let total_assets = event.get("totalAssets").and_then(|v| v.as_u64()).unwrap_or(0);
        let mut summary_parts: Vec<String> = vec![
            format!("{} images", images.len()),
            format!("{} inline SVGs", inline_svgs.len()),
        ];
        let bg_frames = frames_sum(&bg_sprites);
        if bg_frames > 0 {
            summary_parts.push(format!("{bg_frames} CSS sprite frames"));
        }
        if !svg_sprites.is_empty() {
            summary_parts.push(format!("{} SVG symbols", svg_sprites.len()));
        }
        if !mask_sprites.is_empty() {
            summary_parts.push(format!("{} mask sprite frames", frames_sum(&mask_sprites)));
        }
        let total_glyphs: usize = icon_fonts
            .iter()
            .map(|f| f.get("glyphs").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0))
            .sum();
        if total_glyphs > 0 {
            summary_parts.push(format!("{total_glyphs} icon font glyphs"));
        }
        summary_parts.push(format!("{total_assets} total assets"));

        Ok(envelope(json!({
            "summary": format!("{}.", summary_parts.join(", ")),
            "data": data,
            "issues": issues,
            "metadata": { "timeRange": { "from": ts, "to": ts }, "eventCount": 1, "sessionId": session_id, "projectId": args.project_id },
        })))
    }

    #[tool(description = "Compare computed styles between two captured element snapshots to check how closely a recreation matches the original. DEFERRED in the Rust collector: no stored computed-style diff source is available yet.")]
    async fn get_style_diff(
        &self,
        Parameters(args): Parameters<StyleDiffArgs>,
    ) -> Result<CallToolResult, ErrorData> {
        let _ = (&args.source_selector, &args.target_selector, &args.properties, &args.specific_properties);
        Ok(envelope(json!({
            "summary": "get_style_diff is deferred in the Rust collector port — no stored computed-style events to diff yet.",
            "data": null,
            "issues": ["Deferred: style-diff capability not yet implemented in the Rust collector"],
            "metadata": { "deferred": true, "eventCount": 0, "sessionId": null, "projectId": args.project_id },
        })))
    }
}

/// Recursively count nodes whose `display` value contains `display_type` (matches
/// the TS `countByDisplay` helper: `node.display?.includes(displayType)`).
fn count_by_display(node: &Value, display_type: &str) -> usize {
    if node.is_null() {
        return 0;
    }
    let mut count = node
        .get("display")
        .and_then(|v| v.as_str())
        .map(|d| if d.contains(display_type) { 1 } else { 0 })
        .unwrap_or(0);
    if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
        for child in children {
            count += count_by_display(child, display_type);
        }
    }
    count
}

/// Map a property-group name to its concrete CSS property list, or `None` for "all".
fn property_group(name: &str) -> Option<&'static [&'static str]> {
    match name {
        "colors" => Some(&[
            "color", "background-color", "border-color", "border-top-color", "border-right-color",
            "border-bottom-color", "border-left-color", "outline-color", "text-decoration-color",
            "box-shadow", "text-shadow",
        ]),
        "typography" => Some(&[
            "font-family", "font-size", "font-weight", "font-style", "line-height",
            "letter-spacing", "text-align", "text-transform", "text-decoration",
            "word-spacing", "white-space", "text-overflow",
        ]),
        "spacing" => Some(&[
            "margin-top", "margin-right", "margin-bottom", "margin-left",
            "padding-top", "padding-right", "padding-bottom", "padding-left", "gap",
        ]),
        "layout" => Some(&[
            "display", "position", "top", "right", "bottom", "left",
            "width", "height", "min-width", "max-width", "min-height", "max-height",
            "flex-direction", "justify-content", "align-items", "flex-wrap", "flex-grow", "flex-shrink",
            "grid-template-columns", "grid-template-rows", "grid-column", "grid-row",
            "overflow", "z-index",
        ]),
        "borders" => Some(&[
            "border-width", "border-style", "border-color", "border-radius",
            "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
            "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
            "outline-width", "outline-style", "outline-color", "outline-offset",
        ]),
        "visual" => Some(&[
            "opacity", "background-color", "background-image", "background-size", "background-position",
            "box-shadow", "text-shadow", "filter", "backdrop-filter",
            "transform", "transition", "animation",
        ]),
        _ => None,
    }
}
