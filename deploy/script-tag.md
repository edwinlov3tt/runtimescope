# Script-Tag Install (No Build System)

For sites hosted on SiteGround, traditional PHP servers, WordPress, static HTML, Webflow export, or anywhere else you can't run `npm install`.

## Requirements

- A running RuntimeScope collector with a public URL. See [deploy/README.md](./README.md) for one-click deploy options.
- A projectId — generate with `openssl rand -hex 6 | sed 's/^/proj_/'` or let the collector auto-assign on first connect.

## Install

Add this **before `</body>`** in your layout / footer template:

```html
<script src="https://runtimescope.yourcompany.com/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    dsn: 'runtimescopes://proj_xxx@runtimescope.yourcompany.com',
  });
</script>
```

That's it. The SDK is ~3KB gzipped and captures network, console, errors, performance, and renders automatically.

## Per-platform placement

| Platform | Where to paste |
|----------|----------------|
| **WordPress** | `footer.php` in your theme, or use the "Insert Headers and Footers" plugin |
| **SiteGround / PHP** | `includes/footer.php` or the HTML layout file |
| **Static HTML** | Every HTML file, or use a build step to inject into each page |
| **Webflow** | Project Settings → Custom Code → Footer Code |
| **Squarespace** | Site Settings → Advanced → Code Injection → Footer |
| **Shopify** | `theme.liquid`, right before `</body>` |
| **Drupal** | `html.html.twig` or via the Asset Injector module |

## DSN Format Reminder

```
runtimescopes://proj_xxx@your-collector.example.com
 │              │        │
 │              │        └── Your collector's public hostname (no port for standard TLS 443)
 │              └── Project ID (you make this up — the collector creates it server-side if new)
 └── Use "runtimescopes://" for HTTPS/WSS (production). "runtimescope://" is HTTP-only (localhost dev).
```

## Local dev

For local testing against a locally-running collector:

```html
<script src="http://localhost:6768/runtimescope.js"></script>
<script>
  RuntimeScope.init({
    dsn: 'runtimescope://proj_xxx@localhost:6768/my-app',
  });
</script>
```

## Notes

- The `<script>` tag is synchronous — add `async` or `defer` only if you want to skip capturing very-early page loads. For most apps, synchronous is correct: the SDK patches fetch/console before your app runs.
- If `RuntimeScope.init` is called and the collector is unreachable, the SDK fails silently with one `console.debug` message. It will NOT break your site.
- The IIFE bundle defines `window.RuntimeScope` globally. If your site already has a global called `RuntimeScope`, alias it: `window.RS = window.RuntimeScope; delete window.RuntimeScope;`
