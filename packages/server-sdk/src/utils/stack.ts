const INTERNAL_FRAMES = [
  'RuntimeScope',
  'server-sdk',
  'captureQuery',
  'instrumentPrisma',
  'instrumentDrizzle',
  'instrumentKnex',
  'instrumentPg',
  'instrumentMysql2',
  'instrumentBetterSqlite3',
];

export function captureStack(skipFrames = 3): string {
  const err = new Error();
  const stack = err.stack ?? '';
  const lines = stack.split('\n').slice(skipFrames);

  // Filter out internal frames
  const filtered = lines.filter(
    (line) => !INTERNAL_FRAMES.some((frame) => line.includes(frame))
  );

  return filtered.slice(0, 10).join('\n');
}
