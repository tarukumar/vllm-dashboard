/**
 * Resolves a dynamic eval baseline from Databricks.
 *
 * The baseline is the latest release image that has eval data, unless a
 * specific image is requested.  No static YAML — the baseline always comes
 * from the data warehouse.
 */

import { loadEvalRows, type EvalRow, type EvalMetric } from "@/lib/eval-data";
import {
  classifyImage,
  groupImagesByKind,
  type ImageInfo,
} from "@/lib/commit-from-image";

export interface BaselineMetric {
  model: string;
  task: string;
  metric: string;
  filter: string;
  value: number;
  stderr: number;
  higherIsBetter: boolean;
  nShot: number;
  nSamples: number;
  runDate: string;
  image: string;
}

export interface EvalBaseline {
  baselineImage: string;
  imageInfo: ImageInfo;
  resolvedAt: string;
  metrics: BaselineMetric[];
}

/**
 * Build a composite key for deduplication: one value per
 * (model, task, metric, filter) combination, keeping the latest run.
 */
function baselineKey(
  model: string,
  task: string,
  metric: string,
  filter: string,
): string {
  return [model, task, metric, filter].join("|");
}

function extractMetrics(rows: EvalRow[]): BaselineMetric[] {
  const latest = new Map<string, { row: EvalRow; metric: EvalMetric }>();

  for (const row of rows) {
    for (const m of row.metrics) {
      const key = baselineKey(row.model, row.task, m.name, m.filter);
      const existing = latest.get(key);
      if (!existing || row.run_epoch > existing.row.run_epoch) {
        latest.set(key, { row, metric: m });
      }
    }
  }

  const out: BaselineMetric[] = [];
  for (const { row, metric } of latest.values()) {
    out.push({
      model: row.model,
      task: row.task,
      metric: metric.name,
      filter: metric.filter,
      value: metric.value,
      stderr: metric.stderr,
      higherIsBetter: metric.higher_is_better,
      nShot: row.n_shot,
      nSamples: row.n_samples,
      runDate: row.run_date,
      image: row.image ?? "",
    });
  }

  return out.sort((a, b) =>
    a.model.localeCompare(b.model) ||
    a.task.localeCompare(b.task) ||
    a.metric.localeCompare(b.metric) ||
    a.filter.localeCompare(b.filter),
  );
}

/**
 * Find the latest release image that has eval data.
 *
 * Loads all eval rows, groups their images by kind, and picks the first
 * (newest) release.  Returns null when no release image has eval data.
 */
async function resolveLatestReleaseImage(): Promise<string | null> {
  const allRows = await loadEvalRows();
  const images = [...new Set(
    allRows.map((r) => r.image).filter((img): img is string => img !== null),
  )];

  const epochByImage = new Map<string, number>();
  for (const row of allRows) {
    if (!row.image) continue;
    const prev = epochByImage.get(row.image) ?? 0;
    if (row.run_epoch > prev) epochByImage.set(row.image, row.run_epoch);
  }

  const dates: Record<string, string> = {};
  for (const [img, epoch] of epochByImage) {
    dates[img] = new Date(epoch * 1000).toISOString();
  }

  const groups = groupImagesByKind(images, dates);
  return groups.release[0] ?? null;
}

/**
 * Find the latest nightly image that has eval data.
 */
export async function resolveLatestNightlyImage(): Promise<string | null> {
  const allRows = await loadEvalRows();
  const images = [...new Set(
    allRows.map((r) => r.image).filter((img): img is string => img !== null),
  )];

  const epochByImage = new Map<string, number>();
  for (const row of allRows) {
    if (!row.image) continue;
    const prev = epochByImage.get(row.image) ?? 0;
    if (row.run_epoch > prev) epochByImage.set(row.image, row.run_epoch);
  }

  const dates: Record<string, string> = {};
  for (const [img, epoch] of epochByImage) {
    dates[img] = new Date(epoch * 1000).toISOString();
  }

  const groups = groupImagesByKind(images, dates);
  return groups.nightly[0] ?? null;
}

/**
 * Resolve the eval baseline.
 *
 * @param image  Explicit baseline image.  When omitted, the latest release
 *               image with eval data is used.
 */
export async function resolveEvalBaseline(
  image?: string | null,
): Promise<EvalBaseline | null> {
  const baselineImage = image || await resolveLatestReleaseImage();
  if (!baselineImage) return null;

  const rows = await loadEvalRows({ image: baselineImage });
  if (rows.length === 0) return null;

  return {
    baselineImage,
    imageInfo: classifyImage(baselineImage),
    resolvedAt: new Date().toISOString(),
    metrics: extractMetrics(rows),
  };
}
