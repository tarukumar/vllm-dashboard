import { NextRequest, NextResponse } from "next/server";
import { resolveEvalBaseline } from "@/lib/eval-baseline";
import { getCached, setCache } from "@/lib/api-cache";
import { cachedJson } from "@/lib/api-response";

const TTL = 300_000;
const CDN_CACHE = { maxAge: 300, staleWhileRevalidate: 3_600 };

export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const image = sp.get("image");

    const cacheKey = `eval:baseline:${image ?? "latest"}`;
    const cached = getCached(cacheKey);
    if (cached) return cachedJson(cached, CDN_CACHE);

    const baseline = await resolveEvalBaseline(image);
    if (!baseline) {
      return NextResponse.json(
        { error: "No eval baseline found", baselineImage: null, metrics: [] },
        { status: 404 },
      );
    }

    setCache(cacheKey, baseline, TTL);
    return cachedJson(baseline, CDN_CACHE);
  } catch (error) {
    console.error("Failed to resolve eval baseline:", error);
    return NextResponse.json(
      { error: "Failed to resolve eval baseline" },
      { status: 500 },
    );
  }
}
