import { describe, it, expect, beforeEach, vi } from 'vitest';
import { registerProcessMonitorTools } from '../tools/process-monitor.js';
import { createMcpStub } from './tool-harness.js';

function stubProcessMonitor(options: {
  processes?: any[];
  issues?: any[];
  portUsage?: any[];
  killResult?: { success: boolean; error?: string };
} = {}) {
  return {
    scan: vi.fn(),
    getProcesses: vi.fn(() => options.processes ?? []),
    detectIssues: vi.fn(() => options.issues ?? []),
    killProcess: vi.fn(() => options.killResult ?? { success: true }),
    getPortUsage: vi.fn(() => options.portUsage ?? []),
    start: vi.fn(),
    stop: vi.fn(),
  } as any;
}

describe('process monitor MCP tools', () => {
  describe('get_dev_processes', () => {
    let callTool: (name: string, args?: Record<string, unknown>) => Promise<any>;

    it('returns response envelope structure', async () => {
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerProcessMonitorTools(server, stubProcessMonitor());
      const result = await callTool('get_dev_processes', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('issues');
      expect(result).toHaveProperty('metadata');
    });

    it('returns empty when no processes', async () => {
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerProcessMonitorTools(server, stubProcessMonitor());
      const result = await callTool('get_dev_processes', {});
      expect(result.data).toEqual([]);
      expect(result.summary).toContain('0 dev process');
    });

    it('maps process data fields correctly', async () => {
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerProcessMonitorTools(server, stubProcessMonitor({
        processes: [{
          pid: 12345,
          type: 'next',
          command: 'node .next/server.js',
          cpuPercent: 5.2,
          memoryMB: 256.7,
          ports: [3000],
          cwd: '/home/user/myapp',
          project: 'myapp',
          isOrphaned: false,
        }],
      }));
      const result = await callTool('get_dev_processes', {});
      expect(result.data).toHaveLength(1);
      const p = result.data[0];
      expect(p.pid).toBe(12345);
      expect(p.type).toBe('next');
      expect(p.cpuPercent).toBe('5.2%');
      expect(p.memoryMB).toBe('257MB');
      expect(p.ports).toEqual([3000]);
      expect(p.project).toBe('myapp');
      expect(p.isOrphaned).toBe(false);
    });

    it('includes issues from process monitor', async () => {
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerProcessMonitorTools(server, stubProcessMonitor({
        processes: [{ pid: 1, type: 'node', command: 'node', cpuPercent: 0, memoryMB: 1200, ports: [], cwd: null, project: null, isOrphaned: true }],
        issues: [{ title: 'Orphaned process: node (PID 1)', severity: 'low', pattern: 'orphaned_process' }],
      }));
      const result = await callTool('get_dev_processes', {});
      expect(result.issues).toContain('Orphaned process: node (PID 1)');
    });

    it('calls scan before getting processes', async () => {
      const pm = stubProcessMonitor();
      const { server, callTool: ct } = createMcpStub();
      callTool = ct;
      registerProcessMonitorTools(server, pm);
      await callTool('get_dev_processes', {});
      expect(pm.scan).toHaveBeenCalled();
    });
  });

  describe('kill_process', () => {
    it('returns success message on kill', async () => {
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, stubProcessMonitor({ killResult: { success: true } }));
      const result = await ct('kill_process', { pid: 12345 });
      expect(result.summary).toContain('terminated');
      expect(result.summary).toContain('12345');
      expect(result.data.success).toBe(true);
    });

    it('returns error on failed kill', async () => {
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, stubProcessMonitor({ killResult: { success: false, error: 'EPERM' } }));
      const result = await ct('kill_process', { pid: 99999 });
      expect(result.summary).toContain('Failed');
      expect(result.issues).toContain('EPERM');
    });

    it('passes signal to killProcess', async () => {
      const pm = stubProcessMonitor({ killResult: { success: true } });
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, pm);
      await ct('kill_process', { pid: 123, signal: 'SIGKILL' });
      expect(pm.killProcess).toHaveBeenCalledWith(123, 'SIGKILL');
    });
  });

  describe('get_port_usage', () => {
    it('returns response envelope', async () => {
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, stubProcessMonitor());
      const result = await ct('get_port_usage', {});
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('data');
    });

    it('maps port usage fields', async () => {
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, stubProcessMonitor({
        portUsage: [
          { port: 3000, pid: 123, process: 'next-server', type: 'next', project: 'myapp' },
          { port: 5432, pid: 456, process: 'postgres', type: 'postgres', project: null },
        ],
      }));
      const result = await ct('get_port_usage', {});
      expect(result.data).toHaveLength(2);
      expect(result.data[0].port).toBe(3000);
      expect(result.data[0].process).toBe('next-server');
      expect(result.data[1].project).toBeNull();
    });

    it('summary includes binding count', async () => {
      const { server, callTool: ct } = createMcpStub();
      registerProcessMonitorTools(server, stubProcessMonitor({
        portUsage: [{ port: 3000, pid: 1, process: 'node', type: 'node', project: null }],
      }));
      const result = await ct('get_port_usage', {});
      expect(result.summary).toContain('1 port binding');
    });
  });
});
