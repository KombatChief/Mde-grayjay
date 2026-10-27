// MDE.tv source plugin for Grayjay (unofficial)
//
// Uses MDE.tv's own API (api.mde.tv/v1), the same one the website uses.
//   Series  -> Grayjay creators   https://www.mde.tv/series/{tag}
//   Writers -> Grayjay creators   https://www.mde.tv/posts?writer={userId}
//   Episodes -> videos            https://www.mde.tv/series/{tag}/{slug}
//   Screeds  -> posts             https://www.mde.tv/posts/{id}
//
// Login is cookie based (mde-access-token / mde-refresh-token). Grayjay sends
// those cookies on every request made with the authenticated client.

const PLATFORM = "MDE.tv";
const SITE = "https://www.mde.tv";
const API = "https://api.mde.tv/v1";
const LOGO = "https://cdn.mde.tv/logos/logo-basic-alt-white.png";
const DEFAULT_THUMB = "https://www.mde.tv/poster.png";
const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const PAGE_SIZE = 20;

const REGEX_SERIES = /^https?:\/\/(?:www\.)?mde\.tv\/series\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const REGEX_VIDEO = /^https?:\/\/(?:www\.)?mde\.tv\/series\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;
const REGEX_WRITER = /^https?:\/\/(?:www\.)?mde\.tv\/posts\?(?:.*&)?writer=([A-Za-z0-9_-]+)/;
const REGEX_POST = /^https?:\/\/(?:www\.)?mde\.tv\/posts\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/;

let config = {};
let settings = {};
let cache = {};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

source.enable = function (conf, sett, savedState) {
    config = conf ?? {};
    settings = sett ?? {};
    cache = {};
};

source.saveState = function () { return ""; };

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

source.getHome = function (continuationToken) {
    const all = getHomeFeed();
    return new ArrayPager(all, 0, 30);
};

function getHomeFeed() {
    if (cache.home) return cache.home;
    const series = getSeriesList();

    // Newest episodes from every series, fetched in parallel
    const batch = http.batch();
    for (const s of series) batch.GET(apiUrl("/series/" + s.tag + "/videos?page=0&pageSize=8&order=desc"), apiHeaders(), bridge.isLoggedIn());
    const resps = batch.execute();

    let items = [];
    for (let i = 0; i < resps.length; i++) {
        const r = resps[i];
        if (!r || !r.isOk) continue;
        try {
            const j = JSON.parse(r.body);
            for (const v of (j.videos ?? [])) items.push({ date: toUnix(v.published_at ?? v.created_at), item: toPlatformVideo(v, series[i]) });
        } catch (e) { debug("home parse failed for " + series[i].tag + ": " + e); }
    }
    if (settings.homeScreeds !== false && settings.homeScreeds !== "false") {
        for (const p of getAllPosts()) items.push({ date: toUnix(p.created_at), item: toPlatformPost(p) });
    }
    items.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
    cache.home = items.map(x => x.item);
    return cache.home;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

source.searchSuggestions = function (query) { return []; };

source.getSearchCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [], filters: [] };
};

source.search = function (query, type, order, filters, continuationToken) {
    const q = (query ?? "").trim();
    const results = [];
    const j = apiGetJson("/search?query=" + encodeURIComponent(q));
    const seriesById = {};
    for (const s of getSeriesList()) seriesById[s.id] = s;
    for (const v of (j.results ?? [])) results.push(toPlatformVideo(v, seriesById[v.series]));

    const ql = q.toLowerCase();
    for (const p of getAllPosts()) {
        if ((p.title ?? "").toLowerCase().includes(ql) || stripHtml(p.content).toLowerCase().includes(ql) ||
            (p.user?.display_name ?? "").toLowerCase().includes(ql))
            results.push(toPlatformPost(p));
    }
    return new ContentPager(results, false, {});
};

source.searchChannels = function (query, continuationToken) {
    const q = (query ?? "").toLowerCase().trim();
    const channels = getAllChannels().filter(c => !q || c.name.toLowerCase().includes(q) || (c.description ?? "").toLowerCase().includes(q));
    return new ChannelPager(channels, false, {});
};

// ---------------------------------------------------------------------------
// Channels: series and screed writers
// ---------------------------------------------------------------------------

source.isChannelUrl = function (url) {
    return REGEX_SERIES.test(url ?? "") || REGEX_WRITER.test(url ?? "");
};

source.getChannel = function (url) {
    let m = REGEX_SERIES.exec(url);
    if (m) {
        const s = getSeriesList().find(x => x.tag === m[1]);
        if (s) return seriesToChannel(s);
        // Not in the public list (e.g. hidden series): fetch it directly
        const j = apiGetJson("/series/" + m[1] + "/videos?page=0&pageSize=1&order=desc");
        if (j.series) return seriesToChannel(j.series);
        throw new ScriptException("Unknown MDE.tv series: " + m[1]);
    }
    m = REGEX_WRITER.exec(url);
    if (m) {
        const w = getWriters().find(x => x.id === m[1]);
        if (w) return writerToChannel(w);
        throw new ScriptException("Unknown MDE.tv writer: " + m[1]);
    }
    throw new ScriptException("Not an MDE.tv channel URL: " + url);
};

source.getChannelCapabilities = function () {
    return { types: [Type.Feed.Mixed], sorts: [Type.Order.Chronological], filters: [] };
};

source.getChannelContents = function (url, type, order, filters, continuationToken) {
    let m = REGEX_SERIES.exec(url);
    if (m) return new SeriesPager(m[1], 0);
    m = REGEX_WRITER.exec(url);
    if (m) {
        const posts = getAllPosts().filter(p => p.user_id === m[1] || p.user?.id === m[1]).map(toPlatformPost);
        return new ContentPager(posts, false, {});
    }
    return new ContentPager([], false, {});
};

class SeriesPager extends ContentPager {
    constructor(tag, page) {
        const j = apiGetJson("/series/" + tag + "/videos?page=" + page + "&pageSize=" + PAGE_SIZE + "&order=desc");
        const vids = (j.videos ?? []).map(v => toPlatformVideo(v, j.series));
        const total = j.total ?? 0;
        super(vids, vids.length > 0 && (page + 1) * PAGE_SIZE < total, { tag: tag, page: page });
        this.tag = tag;
        this.page = page;
    }
    nextPage() { return new SeriesPager(this.tag, this.page + 1); }
}

// "Import subscriptions" fills the Creators tab with every series and writer
source.getUserSubscriptions = function () {
    return getAllChannels().map(c => c.url);
};

// ---------------------------------------------------------------------------
// Content details
// ---------------------------------------------------------------------------

source.isContentDetailsUrl = function (url) {
    return REGEX_VIDEO.test(url ?? "") || REGEX_POST.test(url ?? "");
};

source.getContentDetails = function (url) {
    let m = REGEX_VIDEO.exec(url);
    if (m) return getVideoDetails(m[1], m[2]);
    m = REGEX_POST.exec(url);
    if (m) return getPostDetails(m[1]);
    throw new ScriptException("Not an MDE.tv video or screed URL: " + url);
};

function getVideoDetails(seriesTag, slug) {
    const j = apiGetJson("/videos/" + slug);
    const v = j.video;
    if (!v) throw new UnavailableException("MDE.tv couldn't find this video.");
    const d = j.details ?? {};
    const series = getSeriesList().find(s => s.tag === (v.series_tag ?? seriesTag));

    // Signed HLS playlist (requires access to the series for paid videos)
    const signResp = http.GET(apiUrl("/videos/" + v.id + "/sign"), apiHeaders(), bridge.isLoggedIn());
    if (!signResp.isOk) {
        debug("sign " + v.id + " -> HTTP " + signResp.code);
        if (signResp.code === 401 || signResp.code === 403) {
            if (!bridge.isLoggedIn())
                throw new ScriptLoginRequiredException("This MDE.tv video is for members. Log in to MDE.tv in the plugin settings to watch it.");
            throw new UnavailableException("Your MDE.tv account doesn't have access to this video. If you should have access, log out and back in to MDE.tv in the plugin settings.");
        }
        throw new ScriptException("MDE.tv returned HTTP " + signResp.code + " when loading the stream.");
    }
    const sig = JSON.parse(signResp.body);
    if (!sig.hls) throw new UnavailableException("MDE.tv didn't return a stream for this video.");

    const base = toPlatformVideo(Object.assign({}, v, { views: d.views ?? v.views }), series);
    const subtitles = (j.captions ?? []).filter(c => c.url).map(c => ({
        name: c.label ?? c.srclang ?? "Captions",
        url: c.url,
        format: "text/vtt",
        language: (c.srclang ?? "en").split("-")[0]
    }));

    const details = new PlatformVideoDetails({
        id: base.id,
        name: base.name,
        thumbnails: base.thumbnails,
        author: base.author,
        datetime: base.datetime,
        duration: base.duration,
        viewCount: base.viewCount,
        url: base.url,
        shareUrl: base.url,
        isLive: false,
        description: v.description || v.transcript_summary || "",
        video: new VideoSourceDescriptor([
            new HLSSource({
                name: "HLS", url: sig.hls, duration: v.duration ?? 0, priority: true,
                // The video CDN may check where playback is coming from
                requestModifier: { headers: { "Referer": SITE + "/", "Origin": SITE } }
            })
        ]),
        rating: new RatingLikesDislikes(d.likes ?? 0, d.dislikes ?? 0),
        subtitles: subtitles
    });

    details.getContentRecommendations = function () {
        try {
            const r = apiGetJson("/videos/" + v.id + "/related");
            const list = Array.isArray(r) ? r : (r.videos ?? r.related ?? []);
            const seriesById = {};
            for (const s of getSeriesList()) seriesById[s.id] = s;
            return new ContentPager(list.map(x => toPlatformVideo(x, seriesById[x.series])), false, {});
        } catch (e) {
            return new ContentPager([], false, {});
        }
    };
    return details;
}

function getPostDetails(id) {
    const j = apiGetJson("/posts/" + id);
    const p = j.post;
    if (!p) throw new UnavailableException("MDE.tv couldn't find this screed.");
    const base = toPlatformPost(p);
    return new PlatformPostDetails({
        id: base.id,
        name: base.name,
        author: base.author,
        datetime: base.datetime,
        url: base.url,
        thumbnails: base.thumbnails,
        images: base.images,
        description: base.description,
        rating: new RatingLikesDislikes(num(p.likes) ?? 0, num(p.dislikes) ?? 0),
        textType: Type.Text.HTML,
        content: (p.poster ? "<p><img src=\"" + p.poster + "\"/></p>" : "") + (p.content ?? "")
    });
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

function getSeriesList() {
    if (cache.series) return cache.series;
    const j = apiGetJson("/series/video");
    const list = (j.series ?? (Array.isArray(j) ? j : [])).filter(s => s.tag);
    list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    cache.series = list;
    debug("series: " + list.map(s => s.tag).join(", "));
    return list;
}

function getAllPosts() {
    if (cache.posts) return cache.posts;
    const posts = [];
    for (let page = 0; page < 50; page++) {
        const j = apiGetJson("/posts?page=" + page);
        const batch = j.posts ?? [];
        posts.push(...batch);
        if (batch.length === 0 || posts.length >= (j.total ?? 0)) break;
    }
    cache.posts = posts;
    return posts;
}

function getWriters() {
    const map = {};
    for (const p of getAllPosts()) {
        const u = p.user;
        const id = u?.id ?? p.user_id;
        if (!id) continue;
        if (!map[id]) map[id] = { id: id, name: u?.display_name ?? "Writer", photo: u?.photo, bio: u?.bio, count: 0 };
        map[id].count++;
    }
    return Object.values(map).sort((a, b) => a.name.localeCompare(b.name));
}

function getAllChannels() {
    const channels = getSeriesList().map(seriesToChannel);
    try { for (const w of getWriters()) channels.push(writerToChannel(w)); }
    catch (e) { log("couldn't load screed writers: " + e); }
    return channels;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function toPlatformVideo(v, series) {
    const tag = v.series_tag ?? series?.tag ?? "";
    const seriesName = v.series_name ?? series?.name ?? tag.toUpperCase();
    const url = SITE + "/series/" + tag + "/" + v.tag;
    const thumb = cdnImage(v.medium_thumbnail) ?? cdnImage(v.small_thumbnail) ?? cdnImage(v.thumbnail) ?? DEFAULT_THUMB;
    return new PlatformVideo({
        id: new PlatformID(PLATFORM, v.id ?? v.tag, config.id),
        name: v.title ?? v.tag,
        thumbnails: new Thumbnails([new Thumbnail(thumb, 720)]),
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, series?.id ?? tag, config.id),
            seriesName,
            SITE + "/series/" + tag,
            seriesThumb(series)),
        datetime: toUnix(v.published_at ?? v.created_at) ?? 0,
        duration: Math.round(num(v.duration) ?? 0),
        viewCount: num(v.views) ?? 0,
        url: url,
        shareUrl: url,
        isLive: false
    });
}

function toPlatformPost(p) {
    const writerId = p.user?.id ?? p.user_id;
    const url = SITE + "/posts/" + p.id;
    const images = p.poster ? [p.poster] : [];
    return new PlatformPost({
        id: new PlatformID(PLATFORM, p.id, config.id),
        name: p.title ?? "Screed",
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, writerId ?? "", config.id),
            p.user?.display_name ?? "MDE.tv",
            writerUrl(writerId),
            p.user?.photo ?? LOGO),
        datetime: toUnix(p.created_at) ?? 0,
        url: url,
        description: truncate(stripHtml(p.content), 400),
        images: images,
        thumbnails: images.map(i => new Thumbnails([new Thumbnail(i, 1)]))
    });
}

function seriesToChannel(s) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, s.id ?? s.tag, config.id),
        name: s.name ?? s.tag,
        thumbnail: seriesThumb(s),
        banner: cdnImage(s.medium_thumbnail) ?? "",
        subscribers: 0,
        description: (s.description ?? "") + (s.episodes ? "\n\n" + s.episodes + " episodes" : ""),
        url: SITE + "/series/" + s.tag,
        links: {}
    });
}

function writerToChannel(w) {
    return new PlatformChannel({
        id: new PlatformID(PLATFORM, w.id, config.id),
        name: w.name + " (Screeds)",
        thumbnail: w.photo ?? LOGO,
        banner: "",
        subscribers: 0,
        description: (w.bio ?? "") + "\n\nScreeds on MDE.tv",
        url: writerUrl(w.id),
        links: {}
    });
}

function seriesThumb(s) {
    return cdnImage(s?.small_thumbnail) ?? cdnImage(s?.medium_thumbnail) ?? LOGO;
}

function writerUrl(id) { return SITE + "/posts?writer=" + id; }

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function apiUrl(path) { return API + path; }

function apiHeaders() {
    return {
        "User-Agent": UA,
        "Accept": "application/json",
        "Origin": SITE,
        "Referer": SITE + "/"
    };
}

function apiGetJson(path) {
    const loggedIn = bridge.isLoggedIn();
    const resp = http.GET(apiUrl(path), apiHeaders(), loggedIn);
    if (!resp.isOk) {
        debug("GET " + path + " -> HTTP " + resp.code);
        if ((resp.code === 401 || resp.code === 403) && !loggedIn)
            throw new ScriptLoginRequiredException("Log in to MDE.tv to view this.");
        throw new ScriptException("MDE.tv API returned HTTP " + resp.code + " for " + path);
    }
    try { return JSON.parse(resp.body); }
    catch (e) { throw new ScriptException("MDE.tv API returned something unexpected for " + path); }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

// Simple pager over an in-memory list
class ArrayPager extends ContentPager {
    constructor(all, offset, size) {
        super(all.slice(offset, offset + size), offset + size < all.length, { offset: offset });
        this.all = all;
        this.offset = offset;
        this.size = size;
    }
    nextPage() { return new ArrayPager(this.all, this.offset + this.size, this.size); }
}

// Only use permanent CDN images (stream.mde.tv thumbnails need a short-lived token)
function cdnImage(u) {
    if (typeof u !== "string" || !/^https?:\/\//.test(u)) return null;
    if (/stream\.mde\.tv/.test(u)) return null;
    if (/\s/.test(u)) return null; // e.g. ".../series/Extreme Peace-thumbnail"
    return u;
}

function num(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return parseFloat(v);
    return null;
}

function toUnix(v) {
    if (!v) return null;
    if (typeof v === "number") return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v);
    const t = Date.parse(v);
    return isNaN(t) ? null : Math.floor(t / 1000);
}

function stripHtml(html) {
    return (html ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function truncate(s, n) { return s.length > n ? s.substring(0, n - 1) + "…" : s; }

function log(msg) { try { bridge.log("[MDE.tv] " + msg); } catch (e) { } }
function debug(msg) { if (settings && (settings.debugLogging === true || settings.debugLogging === "true")) log(msg); }

log("MDE.tv plugin loaded");
