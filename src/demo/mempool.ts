// Bitcoin fee + mempool data from mempool.space, with a cached sample fallback for offline runs.

const API = process.env.MEMPOOL_API || "https://mempool.space/api";

interface Recommended { fastestFee: number; halfHourFee: number; hourFee: number; economyFee: number; minimumFee: number }
interface MempoolInfo { count: number; vsize: number; total_fee: number; fee_histogram: [number, number][] }
interface ProjectedBlock { blockVSize: number; nTx: number; medianFee: number; feeRange: number[] }

const SAMPLE = {
  recommended: { fastestFee: 6, halfHourFee: 5, hourFee: 4, economyFee: 2, minimumFee: 1 } as Recommended,
  mempool: { count: 41230, vsize: 38_400_000, total_fee: 21_850_000, fee_histogram: [[20, 900_000], [8, 2_100_000], [5, 4_000_000], [3, 9_000_000], [1.5, 22_400_000]] } as MempoolInfo,
  blocks: [6.1, 4.8, 4.0, 3.4, 3.0, 2.5, 2.1, 1.8].map((m) => ({ blockVSize: 997_000, nTx: 3100, medianFee: m, feeRange: [m - 0.5, m + 4] })) as ProjectedBlock[],
};

let cache: { at: number; source: "mempool.space" | "sample"; recommended: Recommended; mempool: MempoolInfo; blocks: ProjectedBlock[] } | undefined;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

async function snapshot() {
  if (cache && Date.now() - cache.at < 30_000) return cache;
  if (process.env.MEMPOOL_OFFLINE !== "1") {
    try {
      const [recommended, mempool, blocks] = await Promise.all([
        getJson<Recommended>("/v1/fees/recommended"),
        getJson<MempoolInfo>("/mempool"),
        getJson<ProjectedBlock[]>("/v1/fees/mempool-blocks"),
      ]);
      cache = { at: Date.now(), source: "mempool.space", recommended, mempool, blocks };
      return cache;
    } catch {
      // fall through to sample data
    }
  }
  cache = { at: Date.now(), source: "sample", ...SAMPLE };
  return cache;
}

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export async function feeRecommendation(targetMinutes: number) {
  const s = await snapshot();
  const blocks = Math.max(1, Math.ceil(targetMinutes / 10));
  const projected = s.blocks[blocks - 1];
  const tier = targetMinutes <= 10 ? s.recommended.fastestFee : targetMinutes <= 30 ? s.recommended.halfHourFee : targetMinutes <= 60 ? s.recommended.hourFee : s.recommended.economyFee;
  // Bid just above the projected block's median, never below the API's tier estimate for that window.
  const satPerVb = round(Math.max(tier, projected ? projected.medianFee + 0.1 : s.recommended.economyFee, s.recommended.minimumFee));
  return {
    recommended: { satPerVb, targetMinutes, targetBlocks: blocks },
    fastest: s.recommended.fastestFee,
    halfHour: s.recommended.halfHourFee,
    hour: s.recommended.hourFee,
    economy: s.recommended.economyFee,
    minimum: s.recommended.minimumFee,
    source: s.source,
    asOf: new Date(s.at).toISOString(),
  };
}

export async function mempoolSummary() {
  const s = await snapshot();
  const bands = [
    { label: ">= 10 sat/vB", min: 10 },
    { label: "5-10 sat/vB", min: 5 },
    { label: "2-5 sat/vB", min: 2 },
    { label: "< 2 sat/vB", min: 0 },
  ].map((b, i, all) => {
    const max = i === 0 ? Infinity : all[i - 1].min;
    const vsize = s.mempool.fee_histogram.filter(([rate]) => rate >= b.min && rate < max).reduce((a, [, v]) => a + v, 0);
    return { label: b.label, vsizeMB: round(vsize / 1e6, 2) };
  });
  return {
    count: s.mempool.count,
    vsizeMB: round(s.mempool.vsize / 1e6, 1),
    totalFeeBtc: round(s.mempool.total_fee / 1e8, 4),
    blocksToClear: Math.max(1, Math.ceil(s.mempool.vsize / 1e6)),
    nextBlockMedianFee: s.blocks[0]?.medianFee ? round(s.blocks[0].medianFee) : null,
    feeBands: bands,
    source: s.source,
    asOf: new Date(s.at).toISOString(),
  };
}
