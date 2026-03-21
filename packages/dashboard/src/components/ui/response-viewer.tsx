import { useState, useMemo, useCallback, useEffect } from 'react';
import { Copy, Check, Download, ChevronDown, Maximize2, X } from 'lucide-react';
import { cn } from '@/lib/cn';

// --- Binary detection ---

const BINARY_SIGNATURES: [string, string, string][] = [
  // [magic bytes prefix, label, extension]
  ['PK', 'ZIP/Office file', 'xlsx'],
  ['%PDF', 'PDF document', 'pdf'],
  ['\x89PNG', 'PNG image', 'png'],
  ['\xff\xd8\xff', 'JPEG image', 'jpg'],
  ['GIF8', 'GIF image', 'gif'],
  ['RIFF', 'RIFF file', 'webp'],
];

function detectBinary(content: string): { isBinary: boolean; label?: string; ext?: string } {
  // Check for common binary signatures
  for (const [sig, label, ext] of BINARY_SIGNATURES) {
    if (content.startsWith(sig)) return { isBinary: true, label, ext };
  }
  // High ratio of non-printable characters → binary
  const sample = content.slice(0, 200);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) nonPrintable++;
  }
  if (sample.length > 0 && nonPrintable / sample.length > 0.1) {
    return { isBinary: true, label: 'Binary data', ext: 'bin' };
  }
  return { isBinary: false };
}

// --- Format conversions ---

function tryParseJson(content: string): unknown | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function jsonToPretty(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function jsonToXml(obj: unknown, rootName = 'root'): string {
  function toXml(value: unknown, key: string, indent: string): string {
    if (value === null || value === undefined) return `${indent}<${key}/>\n`;
    if (typeof value === 'object' && Array.isArray(value)) {
      return value.map((item, i) => toXml(item, 'item', indent)).join('');
    }
    if (typeof value === 'object' && value !== null) {
      const inner = Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => toXml(v, k, indent + '  '))
        .join('');
      return `${indent}<${key}>\n${inner}${indent}</${key}>\n`;
    }
    const escaped = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `${indent}<${key}>${escaped}</${key}>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${toXml(obj, rootName, '')}`;
}

function jsonToCsv(obj: unknown): string {
  const arr = Array.isArray(obj) ? obj : [obj];
  if (arr.length === 0) return '';
  const first = arr[0];
  if (typeof first !== 'object' || first === null) return JSON.stringify(arr);
  const keys = Object.keys(first as Record<string, unknown>);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = keys.join(',');
  const rows = arr.map((row) => keys.map((k) => escape((row as Record<string, unknown>)[k])).join(','));
  return [header, ...rows].join('\n');
}

function jsonToYaml(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    if (obj.includes('\n') || obj.includes(':') || obj.includes('#')) return `"${obj.replace(/"/g, '\\"')}"`;
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map((item) => {
      const val = jsonToYaml(item, indent + 1);
      return typeof item === 'object' && item !== null
        ? `${pad}- ${val.trimStart()}`
        : `${pad}- ${val}`;
    }).join('\n');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return entries.map(([key, val]) => {
      const yamlVal = jsonToYaml(val, indent + 1);
      if (typeof val === 'object' && val !== null && (Array.isArray(val) ? val.length > 0 : Object.keys(val).length > 0)) {
        return `${pad}${key}:\n${yamlVal}`;
      }
      return `${pad}${key}: ${yamlVal}`;
    }).join('\n');
  }
  return String(obj);
}

// --- Download helper ---

function downloadContent(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadBinary(base64OrRaw: string, filename: string): void {
  // Try base64 first
  try {
    const binary = atob(base64OrRaw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // Fallback: download as raw text
    downloadContent(base64OrRaw, filename, 'application/octet-stream');
  }
}

// --- Component ---

type ViewFormat = 'pretty' | 'raw' | 'xml' | 'csv' | 'yaml';

interface ResponseViewerProps {
  content: string;
  label?: string;
  filename?: string;
}

export function ResponseViewer({ content, label = 'Response', filename = 'response' }: ResponseViewerProps) {
  const [format, setFormat] = useState<ViewFormat>('pretty');
  const [copied, setCopied] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Close fullscreen on Escape
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [fullscreen]);

  const binary = useMemo(() => detectBinary(content), [content]);
  const parsed = useMemo(() => tryParseJson(content), [content]);
  const isJson = parsed !== null;

  const formatted = useMemo(() => {
    if (!isJson) return content;
    switch (format) {
      case 'pretty': return jsonToPretty(parsed);
      case 'raw': return content;
      case 'xml': return jsonToXml(parsed);
      case 'csv': return jsonToCsv(parsed);
      case 'yaml': return jsonToYaml(parsed);
    }
  }, [content, parsed, isJson, format]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [formatted]);

  const handleDownload = useCallback((fmt: string) => {
    setShowDropdown(false);
    if (binary.isBinary) {
      downloadBinary(content, `${filename}.${binary.ext ?? 'bin'}`);
      return;
    }
    const mimeMap: Record<string, string> = {
      json: 'application/json',
      xml: 'application/xml',
      csv: 'text/csv',
      yaml: 'text/yaml',
      raw: 'text/plain',
    };
    const extMap: Record<string, string> = { json: 'json', xml: 'xml', csv: 'csv', yaml: 'yaml', raw: 'txt' };
    const downloadFmt = fmt === 'pretty' ? 'json' : fmt;
    const downloadContent_ = downloadFmt === 'json' ? jsonToPretty(parsed!) :
      downloadFmt === 'xml' ? jsonToXml(parsed!) :
      downloadFmt === 'csv' ? jsonToCsv(parsed!) :
      downloadFmt === 'yaml' ? jsonToYaml(parsed!) : content;
    downloadContent(downloadContent_, `${filename}.${extMap[downloadFmt] ?? 'txt'}`, mimeMap[downloadFmt] ?? 'text/plain');
  }, [content, parsed, binary, filename]);

  // Binary content — show download button
  if (binary.isBinary) {
    return (
      <div className="rounded-md border border-border-default bg-bg-input p-6 text-center space-y-3">
        <div className="text-text-muted text-sm">{binary.label}</div>
        <div className="text-text-tertiary text-xs">
          {content.length > 1024
            ? `${(content.length / 1024).toFixed(1)} KB`
            : `${content.length} bytes`}
        </div>
        <button
          onClick={() => downloadBinary(content, `${filename}.${binary.ext ?? 'bin'}`)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-brand text-white text-sm font-medium hover:bg-brand/90 transition-colors cursor-pointer"
        >
          <Download size={14} />
          Download {binary.ext?.toUpperCase() ?? 'file'}
        </button>
      </div>
    );
  }

  const FORMAT_LABELS: Record<ViewFormat, string> = {
    pretty: 'Pretty',
    raw: 'Raw',
    xml: 'XML',
    csv: 'CSV',
    yaml: 'YAML',
  };

  const toolbar = (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-border-muted shrink-0">
      <div className="flex items-center gap-1">
        {isJson ? (
          Object.entries(FORMAT_LABELS).map(([key, lbl]) => (
            <button
              key={key}
              onClick={() => setFormat(key as ViewFormat)}
              className={cn(
                'px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider transition-colors cursor-pointer',
                format === key
                  ? 'bg-brand/10 text-brand'
                  : 'text-text-muted hover:text-text-secondary',
              )}
            >
              {lbl}
            </button>
          ))
        ) : (
          <span className="text-[10px] font-medium text-text-muted uppercase tracking-wider">
            {label}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={handleCopy}
          className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-all cursor-pointer"
          title="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
        <div className="relative">
          <button
            onClick={() => setShowDropdown(!showDropdown)}
            className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-all cursor-pointer flex items-center gap-0.5"
            title="Download"
          >
            <Download size={13} />
            <ChevronDown size={10} />
          </button>
          {showDropdown && (
            <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border-default rounded-md shadow-lg z-50 py-1 min-w-[120px]">
              {isJson ? (
                <>
                  <DropdownItem onClick={() => handleDownload('json')} label="JSON" />
                  <DropdownItem onClick={() => handleDownload('xml')} label="XML" />
                  <DropdownItem onClick={() => handleDownload('csv')} label="CSV" />
                  <DropdownItem onClick={() => handleDownload('yaml')} label="YAML" />
                </>
              ) : (
                <DropdownItem onClick={() => handleDownload('raw')} label="Download" />
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => setFullscreen(!fullscreen)}
          className="p-1 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover transition-all cursor-pointer"
          title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {fullscreen ? <X size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>
    </div>
  );

  const codeContent = (
    <pre className="p-4 overflow-auto flex-1 min-h-0">
      <code className="font-mono text-[12px] leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
        {formatted}
      </code>
    </pre>
  );

  // Fullscreen overlay
  if (fullscreen) {
    return (
      <>
        {/* Inline placeholder so layout doesn't jump */}
        <div className="rounded-md border border-border-default bg-bg-input p-4 text-center">
          <button
            onClick={() => setFullscreen(false)}
            className="text-sm text-brand hover:underline cursor-pointer"
          >
            Viewing fullscreen — click to close
          </button>
        </div>
        {/* Modal overlay */}
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-6" onClick={() => setFullscreen(false)}>
          <div
            className="bg-bg-default border border-border-default rounded-lg shadow-2xl flex flex-col w-full max-w-5xl"
            style={{ height: 'calc(100vh - 80px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {toolbar}
            {codeContent}
          </div>
        </div>
      </>
    );
  }

  // Inline — stretch to fill parent
  return (
    <div className="flex flex-col rounded-md border border-border-default bg-bg-input flex-1 min-h-0">
      {toolbar}
      {codeContent}
    </div>
  );
}

function DropdownItem({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="block w-full text-left px-3 py-1.5 text-[12px] text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
    >
      {label}
    </button>
  );
}
