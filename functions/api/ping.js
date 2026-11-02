/**
 * Cloudflare Pages Function: POST /api/ping
 * Receives anonymous active install heartbeats from Raazi app.
 * Zero personal data: only anonymous UUID, app version, build number, and Android SDK.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent",
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return new Response(JSON.stringify({ error: "Invalid Content-Type, expected JSON" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const payload = await request.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const { installId, version, build, os } = payload;

    // Validate anonymous UUID
    if (!installId || typeof installId !== "string" || !UUID_REGEX.test(installId.trim())) {
      return new Response(JSON.stringify({ error: "Invalid installId format" }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const cleanId = installId.trim().toLowerCase();
    const cleanVersion = String(version || "unknown").slice(0, 16);
    const cleanBuild = Number(build) || 0;
    const cleanOs = Number(os) || 0;
    const now = Date.now();

    // Check if KV is bound
    if (!env.RAAZI_KV) {
      return new Response(
        JSON.stringify({
          success: true,
          status: "accepted",
          note: "KV namespace not yet bound to RAAZI_KV in Cloudflare Pages settings",
        }),
        { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const kv = env.RAAZI_KV;
    const deviceKey = `dev:${cleanId}`;

    // Read previous record if any
    const existing = await kv.get(deviceKey, { type: "json" }).catch(() => null);
    const isNewDevice = !existing;

    const deviceData = {
      firstSeen: existing ? existing.firstSeen || now : now,
      lastSeen: now,
      version: cleanVersion,
      build: cleanBuild,
      os: cleanOs,
    };

    // Store device with 60-day expiration TTL (5184000 seconds)
    await kv.put(deviceKey, JSON.stringify(deviceData), { expirationTtl: 5184000 });

    // Update aggregate stats summary key
    let summary = await kv.get("stats:summary", { type: "json" }).catch(() => null);
    if (!summary || typeof summary !== "object") {
      summary = {
        totalUniqueInstalls: 0,
        lastUpdated: now,
        versionCounts: {},
        osCounts: {},
      };
    }

    if (isNewDevice) {
      summary.totalUniqueInstalls = (summary.totalUniqueInstalls || 0) + 1;
    }

    summary.lastUpdated = now;
    summary.versionCounts = summary.versionCounts || {};
    summary.versionCounts[cleanVersion] = (summary.versionCounts[cleanVersion] || 0) + (isNewDevice ? 1 : 0);

    const osLabel = cleanOs > 0 ? `API ${cleanOs}` : "Unknown";
    summary.osCounts = summary.osCounts || {};
    summary.osCounts[osLabel] = (summary.osCounts[osLabel] || 0) + (isNewDevice ? 1 : 0);

    await kv.put("stats:summary", JSON.stringify(summary));

    return new Response(
      JSON.stringify({ success: true, recorded: true, isNew: isNewDevice }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Internal Server Error", message: err.message }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
}
