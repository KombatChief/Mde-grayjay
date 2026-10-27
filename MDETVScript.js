// MDE.tv source plugin for Grayjay (unofficial)
//
// MDE.tv is a Next.js site. Pages are server-rendered with their data embedded
// in the HTML (either a __NEXT_DATA__ JSON block or React Server Component
// "flight" chunks pushed through self.__next_f). Rather than depend on a private
// API, this plugin loads the same pages a browser does - using your logged-in
// session cookies when you're signed in - and pulls series, episodes and
// stream URLs out of that embedded data.
//
// URL shapes on the site:
//   https://www.mde.tv/series                  -> all series
//   https://www.mde.tv/series/{code}           -> one series  (Grayjay "channel")
//   https://www.mde.tv/series/{code}/{slug}    -> one episode (Grayjay "video")

const PLATFORM = "MDE.tv";
const BASE = "https://www.mde.tv";
const SERIES_INDEX = BASE + "/series";
const DEFAULT_THUMB = "https://www.mde.tv/poster.png";
const LOGO = "https://cdn.mde.tv/logos/logo-basic-alt-white.png";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";

const REGEX_CHANNEL_URL = /^https?:\/\/(?:www\.)?mde\.tv\/series\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const REGEX_VIDEO_URL = /^https?:\/\/(?:www\.)?mde\.tv\/series\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
// Links as they appear inside HTML / embedded JSON (absolute or root-relative)
const REGEX_LINK = /(?:https?:\/\/(?:www\.)?mde\.tv)?\/series\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?(?=["'\\?#\s<)]|$)/g;
const REGEX_MEDIA = /https?:\\?\/\\?\/[^"'\s<>\\]+?\.(?:m3u8|mp4)(?:\?[^"'\s<>\\]*)?/g;

// Path segments under /series/ that are not series codes
const RESERVED = { "page": 1, "all": 1, "search": 1, "new": 1, "popular": 1, "latest": 1 };

let config = {};
let settings = {};
let pageCache = {};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

source.enable = function (conf, sett, savedState) {
    config = conf ?? {};
    settings = sett ?? {};
    pageCache = {};
};

source.saveState = function () { return ""; };

// ---------------------------------------------------------------------------
// Home / search
// ---------------------------------------------------------------------------

source.getHome = function (continuationToken) {
    const page = loadPage(BASE);
    let videos = videosFromPage(page);
    if (videos.length === 0) {
        // Fall back to the series index, then to the newest episodes per series
        const idx = loadPage(SERIES_INDEX);
        videos = videosFromPage(idx);
    }
    return new VideoPager(videos.map(toPlatformVideo), false, {});
};

source.searchSuggestions = function (query) { return []; };

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [], filters: [] };
};

source.search = function (query, type, order, filters, continuationToken) {
    const q = (query ?? "").toLowerCase().trim();
    let found = [];

    // Try the site's own search page first
    try {
        const page = loadPage(BASE + "/search?q=" + encodeURIComponent(query), true);
        found = videosFromPage(page);
    } catch (e) { log("search page failed: " + e); }

    // Then filter everything we can see on home + series index by title
    if (found.length === 0) {
        const pool = dedupeVideos(videosFromPage(loadPage(BASE)).concat(videosFromPage(loadPage(SERIES_INDEX))));
        found = pool.filter(v => (v.title ?? "").toLowerCase().includes(q) || (v.seriesName ?? "").toLowerCase().includes(q));
    }
    return new VideoPager(found.map(toPlatformVideo), false, {});
};

source.searchChannels = function (query, continuationToken) {
    const q = (query ?? "").toLowerCase().trim();
    const all = getAllSeries();
    const matches = all.filter(s => !q || s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q));
    return new ChannelPager(matches.map(toPlatformChannel), false, {});
};

// ---------------------------------------------------------------------------
// Channels (= MDE.tv series)
// ---------------------------------------------------------------------------

source.isChannelUrl = function (url) {
    const m = REGEX_CHANNEL_URL.exec(url ?? "");
    return !!m && !RESERVED[m[1].toLowerCase()];
};

source.getChannel = function (url) {
    const code = REGEX_CHANNEL_URL.exec(url)[1];
    const page = loadPage(seriesUrl(code));
    const info = seriesInfoFromPage(page, code);
    return toPlatformChannel(info);
};

source.getChannelCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [Type.Order.Chronological], filters: [] };
};

source.getChannelContents = function (url, type, order, filters, continuationToken) {
    const code = REGEX_CHANNEL_URL.exec(url)[1];
    return new MdeSeriesPager(code, 1);
};

class MdeSeriesPager extends VideoPager {
    constructor(code, pageNum) {
        const url = pageNum > 1 ? seriesUrl(code) + "?page=" + pageNum : seriesUrl(code);
        const page = loadPage(url, pageNum > 1);
        const vids = videosFromPage(page).filter(v => v.seriesCode === code);
        const prevKeys = MdeSeriesPager._seen[code] ?? {};
        const fresh = pageNum > 1 ? vids.filter(v => !prevKeys[v.key]) : vids;
        if (pageNum === 1) MdeSeriesPager._seen[code] = {};
        fresh.forEach(v => MdeSeriesPager._seen[code][v.key] = 1);
        // Only keep paging while the site keeps returning new episodes
        super(fresh.map(toPlatformVideo), fresh.length > 0 && page.hasNextPage, { code: code, page: pageNum });
        this.code = code;
        this.pageNum = pageNum;
    }
    nextPage() { return new MdeSeriesPager(this.code, this.pageNum + 1); }
}
MdeSeriesPager._seen = {};

// "Import subscriptions" (Creators tab) - every series on MDE.tv
source.getUserSubscriptions = function () {
    return getAllSeries().map(s => seriesUrl(s.code));
};

// ---------------------------------------------------------------------------
// Videos (= MDE.tv episodes)
// ---------------------------------------------------------------------------

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO_URL.test(url ?? "");
};

source.getContentDetails = function (url) {
    const m = REGEX_VIDEO_URL.exec(url);
    const code = m[1], slug = m[2];
    const page = loadPage(videoUrl(code, slug), true);

    const index = indexPage(page);
    const v = index.videos[code + "/" + slug] ?? baseVideo(code, slug);
    const obj = findBestObjectFor(page, slug);
    const detail = obj ? Object.assign({}, v, videoFieldsFromObject(obj)) : v;

    // Meta tags are always server-rendered, use them to fill gaps
    detail.title = detail.title || stripSiteSuffix(page.meta["og:title"] || page.title) || slugToTitle(slug);
    detail.thumbnail = detail.thumbnail || page.meta["og:image"] || DEFAULT_THUMB;
    detail.description = detail.description || page.meta["og:description"] || page.meta["description"] || "";
    detail.seriesName = detail.seriesName || seriesNameFromDescription(page.meta["description"]) || (index.series[code] ?? {}).name || code.toUpperCase();

    const sources = findStreams(page, obj);
    debug("streams for " + code + "/" + slug + ": " + JSON.stringify(sources.map(s => s.url)));

    if (sources.length === 0) {
        if (!bridge.isLoggedIn()) {
            throw new ScriptLoginRequiredException("This MDE.tv video needs a subscription. Log in to MDE.tv in the plugin settings to watch it.");
        }
        if (looksLocked(page, obj)) {
            throw new UnavailableException("Your MDE.tv account doesn't have access to this video (it may need a higher membership tier).");
        }
        throw new UnavailableException("Couldn't find a playable stream on this MDE.tv page. If this keeps happening, turn on Debug logging in the plugin settings and check the log.");
    }

    const pv = toPlatformVideo(detail);
    return new PlatformVideoDetails({
        id: pv.id,
        name: pv.name,
        thumbnails: pv.thumbnails,
        author: pv.author,
        datetime: pv.datetime,
        duration: pv.duration,
        viewCount: pv.viewCount,
        url: pv.url,
        shareUrl: pv.url,
        isLive: false,
        description: detail.description,
        video: new VideoSourceDescriptor(sources),
        rating: new RatingLikes(detail.likes ?? 0),
        subtitles: []
    });
};

// ---------------------------------------------------------------------------
// Page loading and embedded-data extraction
// ---------------------------------------------------------------------------

function loadPage(url, noCache) {
    if (!noCache && pageCache[url]) return pageCache[url];

    const loggedIn = bridge.isLoggedIn();
    const resp = http.GET(url, {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9"
    }, loggedIn);

    if (!resp.isOk) {
        if ((resp.code === 401 || resp.code === 403) && !loggedIn)
            throw new ScriptLoginRequiredException("Log in to MDE.tv to view this page.");
        throw new ScriptException("MDE.tv returned HTTP " + resp.code + " for " + url);
    }

    const html = resp.body ?? "";
    const page = parsePage(html, url);
    pageCache[url] = page;
    debug("loaded " + url + " (" + html.length + " bytes, " + page.objects.length + " embedded objects, " + page.flight.length + " flight bytes)");
    return page;
}

function parsePage(html, url) {
    const page = { url: url, html: html, meta: {}, title: "", objects: [], flight: "", hasNextPage: false };

    // <meta property|name=... content=...>
    const metaRe = /<meta\s+[^>]*?(?:property|name)=["']([^"']+)["'][^>]*?content=["']([^"']*)["'][^>]*>/gi;
    let mm;
    while ((mm = metaRe.exec(html)) !== null) page.meta[mm[1].toLowerCase()] = decodeHtml(mm[2]);
    const metaRe2 = /<meta\s+[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']([^"']+)["'][^>]*>/gi;
    while ((mm = metaRe2.exec(html)) !== null) if (!page.meta[mm[2].toLowerCase()]) page.meta[mm[2].toLowerCase()] = decodeHtml(mm[1]);
    const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    if (t) page.title = decodeHtml(t[1].trim());

    // Next.js pages router
    const nd = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (nd) { try { page.objects.push(JSON.parse(nd[1])); } catch (e) { debug("bad __NEXT_DATA__"); } }

    // JSON-LD
    const ldRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    while ((mm = ldRe.exec(html)) !== null) { try { page.objects.push(JSON.parse(mm[1])); } catch (e) { } }

    // Next.js app router (React Server Components flight data)
    const chunkRe = /self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\[\s\S])*")\]\)/g;
    const parts = [];
    while ((mm = chunkRe.exec(html)) !== null) {
        try { parts.push(JSON.parse(mm[1])); } catch (e) { }
    }
    page.flight = parts.join("");
    if (page.flight) page.objects = page.objects.concat(parseFlight(page.flight));

    // Pagination hints
    page.hasNextPage = /[?&]page=\d+/.test(html) || /"hasNextPage"\s*:\s*true|"hasMore"\s*:\s*true|"nextCursor"\s*:\s*"[^"]+"/.test(html + page.flight);
    return page;
}

// RSC rows look like  `1a:["$","div",null,{...}]` or `5:{"video":{...}}`
function parseFlight(flight) {
    const out = [];
    const rowRe = /(?:^|\n)([0-9a-fA-F]+):(?=[\[{"IHTEW])/g;
    const starts = [];
    let m;
    while ((m = rowRe.exec(flight)) !== null) starts.push({ at: m.index + m[0].length });
    for (let i = 0; i < starts.length; i++) {
        let body = flight.substring(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : flight.length);
        body = body.replace(/\n?[0-9a-fA-F]+:$/, "").trim();
        if (body[0] === "I" || body[0] === "H" || body[0] === "W") body = body.substring(body[0] === "H" ? 2 : 1);
        if (body[0] !== "[" && body[0] !== "{") continue;
        try { out.push(JSON.parse(body)); } catch (e) { /* partial or text row */ }
    }
    return out;
}

function walk(node, visit, depth) {
    depth = depth ?? 0;
    if (depth > 60 || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n, visit, depth + 1); return; }
    visit(node);
    for (const k in node) walk(node[k], visit, depth + 1);
}

// Everything we know from one page: series and episodes, keyed by code / code+slug
function indexPage(page) {
    if (page._index) return page._index;
    const series = {};
    const videos = {};
    const order = [];
    const text = page.html + "\n" + page.flight;

    // 1) Links
    let m;
    REGEX_LINK.lastIndex = 0;
    while ((m = REGEX_LINK.exec(text)) !== null) {
        const code = m[1], slug = m[2];
        if (RESERVED[code.toLowerCase()]) continue;
        if (!series[code]) series[code] = { code: code, name: "", thumbnail: "", description: "" };
        if (slug) {
            const key = code + "/" + slug;
            if (!videos[key]) { videos[key] = baseVideo(code, slug); order.push(key); }
        }
    }

    // 2) Embedded objects that describe series or episodes
    for (const root of page.objects) {
        walk(root, o => {
            const slug = str(o.slug ?? o.urlSlug ?? o.handle ?? o.permalink);
            const title = str(o.title ?? o.name);
            if (!slug || !title) return;

            const parentCode = str(o.seriesCode ?? o.seriesSlug ?? o.series_code ?? o.series_slug ??
                (o.series && typeof o.series === "object" ? (o.series.code ?? o.series.slug) : null) ??
                (o.show && typeof o.show === "object" ? (o.show.code ?? o.show.slug) : null));

            const pathMatch = /\/series\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)/.exec(str(o.url ?? o.href ?? o.path ?? o.link) ?? "");
            const code = parentCode ?? (pathMatch ? pathMatch[1] : null);

            if (code && code !== slug) {
                const key = code + "/" + slug;
                if (!videos[key]) { videos[key] = baseVideo(code, slug); order.push(key); }
                Object.assign(videos[key], videoFieldsFromObject(o));
                if (o.series && typeof o.series === "object") mergeSeries(series, code, o.series);
            } else if (series[slug] || looksLikeSeries(o)) {
                mergeSeries(series, str(o.code) ?? slug, o);
            }
        });
    }

    // Attach series names to episodes
    for (const key of order) {
        const v = videos[key];
        if (!v.seriesName && series[v.seriesCode]?.name) v.seriesName = series[v.seriesCode].name;
    }
    page._index = { series: series, videos: videos, order: order };
    return page._index;
}

function looksLikeSeries(o) {
    return Array.isArray(o.videos) || Array.isArray(o.episodes) || o.videoCount !== undefined ||
        o.episodeCount !== undefined || o.__typename === "Series" || o.type === "series" || o.kind === "series";
}

function mergeSeries(map, code, o) {
    if (!code) return;
    const s = map[code] ?? (map[code] = { code: code, name: "", thumbnail: "", description: "" });
    s.name = s.name || str(o.title ?? o.name) || "";
    s.thumbnail = s.thumbnail || findImage(o) || "";
    s.banner = s.banner || str(o.banner ?? o.bannerUrl ?? o.cover ?? o.coverUrl ?? o.heroImage) || "";
    s.description = s.description || str(o.description ?? o.summary ?? o.tagline) || "";
}

function videoFieldsFromObject(o) {
    const f = {};
    const title = str(o.title ?? o.name);
    if (title) f.title = title;
    const id = str(o.id ?? o.uuid ?? o._id);
    if (id) f.id = id;
    const thumb = findImage(o);
    if (thumb) f.thumbnail = thumb;
    const desc = str(o.description ?? o.summary ?? o.body);
    if (desc) f.description = desc;

    let dur = num(o.duration ?? o.durationSeconds ?? o.duration_seconds ?? o.length ?? o.runtime);
    if (dur && dur > 60 * 60 * 24) dur = Math.round(dur / 1000); // milliseconds
    if (dur) f.duration = Math.round(dur);

    const dateRaw = o.publishedAt ?? o.published_at ?? o.releaseDate ?? o.releasedAt ?? o.released_at ??
        o.airDate ?? o.createdAt ?? o.created_at ?? o.date;
    const date = toUnix(dateRaw);
    if (date) f.date = date;

    const views = num(o.views ?? o.viewCount ?? o.view_count ?? o.plays);
    if (views) f.views = views;
    const likes = num(o.likes ?? o.likeCount ?? o.like_count);
    if (likes) f.likes = likes;
    if (o.series && typeof o.series === "object") {
        const sn = str(o.series.title ?? o.series.name);
        if (sn) f.seriesName = sn;
    }
    return f;
}

function findImage(o) {
    const keys = ["thumbnail", "thumbnailUrl", "thumbnail_url", "thumb", "image", "imageUrl", "image_url",
        "poster", "posterUrl", "cover", "coverUrl", "artwork", "logo", "avatar", "picture"];
    for (const k of keys) {
        const v = o[k];
        if (typeof v === "string" && /^(https?:)?\/\//.test(v)) return absolutize(v);
        if (v && typeof v === "object") {
            const inner = v.url ?? v.src ?? v.medium ?? v.large ?? v.original ?? v.default;
            if (typeof inner === "string") return absolutize(inner);
        }
    }
    for (const k in o) {
        const v = o[k];
        if (typeof v === "string" && /cdn\.mde\.tv\/thumbnails\//.test(v)) return absolutize(v);
    }
    return null;
}

// The embedded object that best matches a given episode slug
function findBestObjectFor(page, slug) {
    let best = null, bestScore = 0;
    for (const root of page.objects) {
        walk(root, o => {
            if (str(o.slug ?? o.urlSlug ?? o.handle) !== slug) return;
            let score = 1;
            if (o.title || o.name) score += 1;
            if (hasStream(o)) score += 5;
            if (o.description) score += 1;
            score += Math.min(Object.keys(o).length, 30) / 30;
            if (score > bestScore) { best = o; bestScore = score; }
        });
    }
    return best;
}

function hasStream(o) {
    let found = false;
    walk(o, n => {
        for (const k in n) {
            const v = n[k];
            if (typeof v === "string" && (/\.(m3u8|mp4)(\?|$)/.test(v) || /playback_?id/i.test(k))) found = true;
        }
    });
    return found;
}

function findStreams(page, obj) {
    const hls = [];
    const mp4 = [];
    const seen = {};

    const addUrl = (url, hints) => {
        url = absolutize(unescapeUrl(url));
        if (!url || seen[url]) return;
        if (/thumbnail|preview|trailer|sprite|storyboard/i.test(url) && !(hints && hints.forceKeep)) return;
        seen[url] = 1;
        if (/\.m3u8(\?|$)/.test(url)) {
            hls.push(new HLSSource({ name: hints?.name ?? "HLS", url: url, duration: hints?.duration ?? 0, priority: true }));
        } else {
            const h = hints?.height ?? guessHeight(url);
            mp4.push(new VideoUrlSource({
                name: h ? h + "p" : "MP4", url: url, container: "video/mp4",
                width: hints?.width ?? (h ? Math.round(h * 16 / 9) : 0), height: h ?? 0,
                codec: "", bitrate: hints?.bitrate ?? 0, duration: hints?.duration ?? 0
            }));
        }
    };

    // 1) Structured: walk the matched episode object first, then the whole page
    const scan = n => {
        // Mux
        const pid = n.playbackId ?? n.playback_id ?? n.muxPlaybackId ?? n.mux_playback_id;
        if (typeof pid === "string" && /^[A-Za-z0-9]{10,}$/.test(pid)) {
            const token = n.token ?? n.playbackToken ?? n.playback_token ?? n.signedToken;
            addUrl("https://stream.mux.com/" + pid + ".m3u8" + (typeof token === "string" ? "?token=" + token : ""), { forceKeep: true });
        }
        if (Array.isArray(n.playbackIds)) {
            for (const p of n.playbackIds) if (p && typeof p.id === "string") addUrl("https://stream.mux.com/" + p.id + ".m3u8", { forceKeep: true });
        }
        for (const k in n) {
            const v = n[k];
            if (typeof v !== "string") continue;
            if (/\.(m3u8|mp4)(\?|$)/i.test(v) && /^(https?:)?\/\//.test(v)) {
                addUrl(v, { height: num(n.height ?? n.resolution ?? n.quality), width: num(n.width), bitrate: num(n.bitrate) });
            }
        }
    };
    if (obj) walk(obj, scan);
    if (hls.length + mp4.length === 0) for (const root of page.objects) walk(root, scan);

    // 2) Raw text fallback
    if (hls.length + mp4.length === 0) {
        const text = page.html + "\n" + page.flight;
        let m;
        REGEX_MEDIA.lastIndex = 0;
        while ((m = REGEX_MEDIA.exec(text)) !== null) addUrl(m[0]);
    }

    mp4.sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
    return hls.concat(mp4);
}

function looksLocked(page, obj) {
    const text = JSON.stringify(obj ?? {}) + page.flight.substring(0, 200000);
    return /"(locked|isLocked|paywalled|requiresSubscription|premium|isPremium|membersOnly)"\s*:\s*true/i.test(text) ||
        /upgrade|subscribe to watch|members only|producer only/i.test(page.html);
}

// ---------------------------------------------------------------------------
// Series discovery
// ---------------------------------------------------------------------------

function getAllSeries() {
    const map = {};
    const add = (page) => {
        const idx = indexPage(page);
        for (const code in idx.series) {
            const s = idx.series[code];
            if (!map[code]) map[code] = Object.assign({}, s);
            else {
                map[code].name = map[code].name || s.name;
                map[code].thumbnail = map[code].thumbnail || s.thumbnail;
                map[code].description = map[code].description || s.description;
            }
        }
    };
    add(loadPage(SERIES_INDEX));
    try { add(loadPage(BASE)); } catch (e) { log("home load failed: " + e); }

    // Series pages always know their own name; fetch any we couldn't name in parallel
    const unnamed = Object.keys(map).filter(c => !map[c].name);
    if (unnamed.length > 0) {
        const batch = http.batch();
        for (const c of unnamed) batch.GET(seriesUrl(c), { "User-Agent": UA }, bridge.isLoggedIn());
        const resps = batch.execute();
        for (let i = 0; i < unnamed.length; i++) {
            const r = resps[i];
            if (!r || !r.isOk) continue;
            const p = parsePage(r.body, seriesUrl(unnamed[i]));
            pageCache[p.url] = p;
            const info = seriesInfoFromPage(p, unnamed[i]);
            map[unnamed[i]].name = info.name;
            map[unnamed[i]].thumbnail = map[unnamed[i]].thumbnail || info.thumbnail;
            map[unnamed[i]].description = map[unnamed[i]].description || info.description;
        }
    }
    const list = Object.values(map);
    debug("series found: " + list.map(s => s.code + "=" + s.name).join(", "));
    return list.sort((a, b) => a.name.localeCompare(b.name));
}

function seriesInfoFromPage(page, code) {
    const idx = indexPage(page);
    const s = Object.assign({ code: code, name: "", thumbnail: "", description: "" }, idx.series[code] ?? {});
    if (!s.name) s.name = stripSiteSuffix(page.meta["og:title"] || page.title);
    if (!s.name || /^mde\.tv$/i.test(s.name) || /^series$/i.test(s.name)) {
        const firstEp = idx.order.map(k => idx.videos[k]).find(v => v.seriesCode === code && v.seriesName);
        s.name = firstEp ? firstEp.seriesName : code.toUpperCase();
    }
    if (!s.thumbnail) {
        const og = page.meta["og:image"];
        s.thumbnail = og && !/poster\.png$/.test(og) ? og : LOGO;
    }
    if (!s.description) {
        const d = page.meta["og:description"] || page.meta["description"] || "";
        if (!/^The Home for all Million Dollar Extreme/i.test(d)) s.description = d;
    }
    return s;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function videosFromPage(page) {
    const idx = indexPage(page);
    return idx.order.map(k => idx.videos[k]);
}

function dedupeVideos(list) {
    const seen = {};
    return list.filter(v => (seen[v.key] ? false : (seen[v.key] = true)));
}

function baseVideo(code, slug) {
    return { key: code + "/" + slug, seriesCode: code, slug: slug, title: "", thumbnail: "", seriesName: "" };
}

function toPlatformVideo(v) {
    const url = videoUrl(v.seriesCode, v.slug);
    const seriesName = v.seriesName || v.seriesCode.toUpperCase();
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, v.id ?? v.key, config.id),
        name: v.title || slugToTitle(v.slug),
        thumbnails: new Thumbnails([new Thumbnail(v.thumbnail || DEFAULT_THUMB, 720)]),
        author: new PlatformAuthorLink(new PlatformID(PLATFORM, v.seriesCode, config.id), seriesName, seriesUrl(v.seriesCode), LOGO),
        datetime: v.date ?? 0,
        duration: v.duration ?? 0,
        viewCount: v.views ?? 0,
        url: url,
        shareUrl: url,
        isLive: false
    });
}

function toPlatformChannel(s) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, s.code, config.id),
        name: s.name || s.code.toUpperCase(),
        thumbnail: s.thumbnail || LOGO,
        banner: s.banner || "",
        subscribers: 0,
        description: s.description || "",
        url: seriesUrl(s.code),
        links: {}
    });
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function seriesUrl(code) { return SERIES_INDEX + "/" + code; }
function videoUrl(code, slug) { return SERIES_INDEX + "/" + code + "/" + slug; }

function str(v) { return (typeof v === "string" && v.trim().length > 0) ? v.trim() : (typeof v === "number" ? String(v) : null); }
function num(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    return null;
}
function toUnix(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    if (typeof v === "string") {
        if (v.startsWith("$D")) v = v.substring(2); // RSC date encoding
        const t = Date.parse(v);
        return isNaN(t) ? null : Math.floor(t / 1000);
    }
    return null;
}
function absolutize(u) {
    if (!u) return u;
    if (u.startsWith("//")) return "https:" + u;
    if (u.startsWith("/")) return BASE + u;
    return u;
}
function unescapeUrl(u) { return (u ?? "").replace(/\\\//g, "/").replace(/\\u0026/g, "&").replace(/&amp;/g, "&"); }
function decodeHtml(s) {
    return (s ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;|&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)));
}
function stripSiteSuffix(t) { return (t ?? "").replace(/\s*[|\-–]\s*MDE\.tv\s*$/i, "").trim(); }
function slugToTitle(slug) { return (slug ?? "").replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase()); }
function seriesNameFromDescription(d) {
    // e.g. "Watch Perfect Guy Life #118 - #118 Oiler Macaroni on MDE.tv!"
    const m = /^Watch (.+?)(?: #\d+)? - /.exec(d ?? "");
    return m ? m[1].trim() : null;
}
function guessHeight(url) {
    const m = /(?:^|[^0-9])(2160|1440|1080|720|540|480|360|240)p?(?:[^0-9]|$)/.exec(url);
    return m ? parseInt(m[1], 10) : null;
}
function log(msg) { try { bridge.log("[MDE.tv] " + msg); } catch (e) { } }
function debug(msg) { if (settings && (settings.debugLogging === true || settings.debugLogging === "true")) log(msg); }

log("MDE.tv plugin loaded");
