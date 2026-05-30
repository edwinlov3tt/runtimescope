/**
 * Conformance: the WORKSPACE + API-KEY surface of the pm/ subsystem against Node.
 *
 * M5 / ADR-0009. pm/ has NO Node test coverage, so these specs are
 * characterization tests — written green-vs-Node FIRST to pin the (previously
 * untested) behavior, and they double as the Rust port spec. They will be RED vs
 * the Rust binaries until pm/ is ported (the workspace tools are deferred stubs
 * today) — that's the intended Phase-A-style honest-red gate.
 *
 * The MCP server initializes a fresh pm.db under the harness's temp HOME per
 * spawn, so the auto-created "Personal" workspace gives deterministic assertions.
 * Backed by pm-store.ts (createWorkspace/createApiKey/listWorkspaces) +
 * workspaces.ts (the 4 MCP tools).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const WS_ID = /^ws_[0-9a-f]{16}$/;          // generateWorkspaceId(): ws_ + 8 bytes hex
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

interface Ws {
  id: string; name: string; slug: string; description?: string;
  isDefault: boolean; projectCount: number; apiKeyCount: number; createdAt: string;
}

describe('pm/ workspace + API-key surface (Node)', () => {
  it('list_workspaces returns the auto-created Personal workspace on a fresh install', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('list_workspaces', {});
    const env = envelope as { summary: string; data: Ws[] };

    expect(env.data.length).toBe(1);
    const personal = env.data[0];
    expect(personal.name).toBe('Personal');
    expect(personal.slug).toBe('personal');
    expect(personal.description).toBe('Your personal workspace');
    expect(personal.isDefault).toBe(true);
    expect(personal.projectCount).toBe(0);
    expect(personal.apiKeyCount).toBe(0);
    expect(personal.id).toMatch(WS_ID);
    expect(personal.createdAt).toMatch(ISO);
    expect(env.summary).toBe('1 workspace(s). 0 project(s) total.');
  });

  it('create_workspace derives a slug, returns the workspace, and list reflects it', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('create_workspace', { name: 'Work Stuff' });
    const env = envelope as { summary: string; data: { id: string; name: string; slug: string; isDefault: boolean } };

    expect(env.data.id).toMatch(WS_ID);
    expect(env.data.name).toBe('Work Stuff');
    expect(env.data.slug).toBe('work-stuff'); // lowercase, non-alnum → '-', collapsed/trimmed
    expect(env.data.isDefault).toBe(false);
    expect(env.summary).toBe(`Created workspace "Work Stuff" (${env.data.id}).`);

    // list_workspaces now shows both (Personal + the new one).
    const { envelope: listEnv } = await mcp.callTool('list_workspaces', {});
    const list = (listEnv as { data: Ws[] }).data;
    expect(list.length).toBe(2);
    const created = list.find((w) => w.slug === 'work-stuff');
    expect(created).toBeTruthy();
    expect(created!.isDefault).toBe(false);
    expect(created!.name).toBe('Work Stuff');
  });

  it('create_workspace rejects a duplicate slug', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    // "Personal" → slug "personal", which the default workspace already owns.
    const { envelope } = await mcp.callTool('create_workspace', { name: 'Personal' });
    const env = envelope as { summary: string; data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.summary).toBe('Failed to create workspace: Workspace with slug "personal" already exists');
    expect(env.issues).toContain('Workspace with slug "personal" already exists');
  });

  it('create_workspace_api_key returns a tk_ secret once with prefix/last4 and bumps the key count', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const personalId = ((await mcp.callTool('list_workspaces', {})).envelope as { data: Ws[] }).data[0].id;

    const { envelope } = await mcp.callTool('create_workspace_api_key', { workspace_id: personalId, label: 'CI server' });
    const env = envelope as {
      summary: string;
      data: { key: string; keyPrefix: string; keyLast4: string; workspaceId: string; label: string };
    };

    // Raw secret: "tk_" + 24 bytes hex (48 chars). Returned exactly once.
    expect(env.data.key).toMatch(/^tk_[0-9a-f]{48}$/);
    expect(env.data.keyPrefix).toBe(env.data.key.slice(0, 11)); // "tk_" + 8 hex
    expect(env.data.keyPrefix).toMatch(/^tk_[0-9a-f]{8}$/);
    expect(env.data.keyLast4).toBe(env.data.key.slice(-4));
    expect(env.data.workspaceId).toBe(personalId);
    expect(env.data.label).toBe('CI server');
    expect(env.summary).toContain(`Created API key for workspace ${personalId}`);

    // The workspace now reports apiKeyCount: 1 (and the secret is never re-shown).
    const personal = ((await mcp.callTool('list_workspaces', {})).envelope as { data: Ws[] }).data
      .find((w) => w.id === personalId)!;
    expect(personal.apiKeyCount).toBe(1);
  });

  it('create_workspace_api_key rejects an unknown workspace', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('create_workspace_api_key', { workspace_id: 'ws_doesnotexist', label: 'x' });
    const env = envelope as { summary: string; data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.summary).toBe('Failed: Workspace ws_doesnotexist does not exist');
    expect(env.issues).toContain('Workspace ws_doesnotexist does not exist');
  });

  it('move_project_to_workspace reports not-found for an unknown project', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('move_project_to_workspace', { project_id: 'nope', workspace_id: 'ws_x' });
    const env = envelope as { summary: string; data: unknown; issues: string[] };
    expect(env.data).toBeNull();
    expect(env.summary).toBe('Project nope not found.');
    expect(env.issues).toContain('project-not-found');
  });
});
