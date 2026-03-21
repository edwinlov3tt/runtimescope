/**
 * Export data as JSON or CSV and trigger a browser download.
 */

export function downloadJSON(data: unknown[], filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${filename}.json`);
}

export function downloadCSV(data: Record<string, unknown>[], filename: string): void {
  if (data.length === 0) return;
  const keys = Object.keys(data[0]);
  const header = keys.join(',');
  const rows = data.map((row) =>
    keys.map((k) => {
      const val = row[k];
      if (val == null) return '';
      const str = typeof val === 'object' ? JSON.stringify(val) : String(val);
      // Escape CSV fields containing commas, quotes, or newlines
      return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
    }).join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  triggerDownload(blob, `${filename}.csv`);
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
