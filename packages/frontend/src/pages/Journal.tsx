import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { journalApi, type ConnectionLogEntry } from '@/api/journal.api';
import { PageLoader } from '@/components/shared/LoadingSpinner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ChevronLeft, ChevronRight, Globe, MessagesSquare } from 'lucide-react';

// ISO 3166-1 alpha-2 → regional-indicator emoji flag.
function flag(country: string | null): string {
  if (!country || country.length !== 2) return '';
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

let regionNames: Intl.DisplayNames | null = null;
try { regionNames = new Intl.DisplayNames(['fr'], { type: 'region' }); } catch { /* older runtime */ }
function countryName(country: string | null): string {
  if (!country) return '';
  try { return regionNames?.of(country) ?? country; } catch { return country; }
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'medium' });
}

function LocationCell({ e }: { e: ConnectionLogEntry }) {
  if (e.country) {
    return <span title={countryName(e.country)}>{flag(e.country)} {e.country}</span>;
  }
  if (e.ip && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1)/.test(e.ip)) {
    return <Badge variant="outline" className="text-[10px]">LAN</Badge>;
  }
  return <span className="text-muted-foreground">—</span>;
}

const PAGE_SIZE = 50;

export default function Journal() {
  const [source, setSource] = useState<'web' | 'teamspeak'>('web');
  const [page, setPage] = useState(1);
  const [hideBots, setHideBots] = useState(true);

  const { data, isLoading } = useQuery({
    queryKey: ['journal', source, page, hideBots],
    queryFn: () => journalApi.list({ source, page, limit: PAGE_SIZE, hideBots }),
    refetchInterval: 15000,
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const switchSource = (s: 'web' | 'teamspeak') => { setSource(s); setPage(1); };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Connection Journal</h1>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={source} onValueChange={(v) => switchSource(v as any)}>
          <TabsList>
            <TabsTrigger value="web"><Globe className="h-3.5 w-3.5 mr-1" /> Web</TabsTrigger>
            <TabsTrigger value="teamspeak"><MessagesSquare className="h-3.5 w-3.5 mr-1" /> TeamSpeak</TabsTrigger>
          </TabsList>
        </Tabs>

        {source === 'teamspeak' && (
          <div className="flex items-center gap-2">
            <Switch checked={hideBots} onCheckedChange={(v) => { setHideBots(v); setPage(1); }} />
            <Label className="text-xs font-normal">Hide bots</Label>
          </div>
        )}
      </div>

      {isLoading ? <PageLoader /> : (
        <div className="rounded-md border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="h-10 px-3 text-left font-medium text-muted-foreground">Login</th>
                <th className="h-10 px-3 text-left font-medium text-muted-foreground">Date / Time</th>
                <th className="h-10 px-3 text-left font-medium text-muted-foreground">IP</th>
                <th className="h-10 px-3 text-left font-medium text-muted-foreground">Location</th>
                {source === 'web' && <th className="h-10 px-3 text-left font-medium text-muted-foreground">Result</th>}
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 ? (
                <tr><td colSpan={5} className="px-3 py-8 text-center text-xs text-muted-foreground">No entries.</td></tr>
              ) : entries.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2.5">
                    {e.login}
                    {e.isBot && <Badge variant="outline" className="ml-2 text-[10px]">bot</Badge>}
                  </td>
                  <td className="px-3 py-2.5 font-mono-data text-xs">{formatDate(e.createdAt)}</td>
                  <td className="px-3 py-2.5 font-mono-data text-xs">{e.ip || '—'}</td>
                  <td className="px-3 py-2.5"><LocationCell e={e} /></td>
                  {source === 'web' && (
                    <td className="px-3 py-2.5">
                      {e.success
                        ? <span className="text-xs text-emerald-400">Success</span>
                        : <span className="text-xs text-destructive">Failed</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{total} entr{total === 1 ? 'y' : 'ies'}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-muted-foreground">{page} / {totalPages}</span>
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
