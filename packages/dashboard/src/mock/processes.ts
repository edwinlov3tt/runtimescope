import type { DevProcess, PortUsage } from './types';

export const MOCK_PROCESSES: DevProcess[] = [
  {
    pid: 12345, command: 'next dev --port 3000', type: 'next',
    cpuPercent: 12.5, memoryMB: 245, ports: [3000],
    cwd: '/Users/dev/my-app', project: 'my-app', uptime: 7200000, isOrphaned: false,
  },
  {
    pid: 12456, command: 'vite --port 3200', type: 'vite',
    cpuPercent: 3.2, memoryMB: 85, ports: [3200],
    cwd: '/Users/dev/runtime-profiler/packages/dashboard', project: 'runtime-profiler', uptime: 3600000, isOrphaned: false,
  },
  {
    pid: 12567, command: 'prisma studio --port 5555', type: 'prisma',
    cpuPercent: 0.8, memoryMB: 120, ports: [5555],
    cwd: '/Users/dev/my-app', project: 'my-app', uptime: 7200000, isOrphaned: false,
  },
  {
    pid: 12678, command: 'postgres -D /usr/local/var/postgres', type: 'postgres',
    cpuPercent: 1.5, memoryMB: 64, ports: [5432],
    uptime: 86400000, isOrphaned: false,
  },
  {
    pid: 12789, command: 'redis-server /usr/local/etc/redis.conf', type: 'redis',
    cpuPercent: 0.3, memoryMB: 12, ports: [6379],
    uptime: 86400000, isOrphaned: false,
  },
  {
    pid: 13890, command: 'node dist/server.js', type: 'node',
    cpuPercent: 45.2, memoryMB: 512, ports: [9800],
    cwd: '/Users/dev/runtime-profiler/packages/collector', project: 'runtime-profiler', uptime: 3600000, isOrphaned: false,
  },
  {
    pid: 14001, command: 'webpack serve --mode development', type: 'webpack',
    cpuPercent: 8.1, memoryMB: 380, ports: [8080],
    cwd: '/Users/dev/old-project', project: 'old-project', uptime: 172800000, isOrphaned: true,
  },
  {
    pid: 14112, command: 'docker compose up', type: 'docker',
    cpuPercent: 2.4, memoryMB: 156, ports: [3306, 8025],
    cwd: '/Users/dev/my-app', project: 'my-app', uptime: 7200000, isOrphaned: false,
  },
];

export const MOCK_PORTS: PortUsage[] = [
  { port: 3000, pid: 12345, process: 'next dev', type: 'next', project: 'my-app' },
  { port: 3200, pid: 12456, process: 'vite', type: 'vite', project: 'runtime-profiler' },
  { port: 5555, pid: 12567, process: 'prisma studio', type: 'prisma', project: 'my-app' },
  { port: 5432, pid: 12678, process: 'postgres', type: 'postgres' },
  { port: 6379, pid: 12789, process: 'redis-server', type: 'redis' },
  { port: 9800, pid: 13890, process: 'node', type: 'node', project: 'runtime-profiler' },
  { port: 8080, pid: 14001, process: 'webpack', type: 'webpack', project: 'old-project' },
  { port: 3306, pid: 14112, process: 'docker (mysql)', type: 'docker', project: 'my-app' },
  { port: 8025, pid: 14112, process: 'docker (mailhog)', type: 'docker', project: 'my-app' },
];
