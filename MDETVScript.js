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
let state = {};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

source.enable = function (conf, sett, savedState) {
    config = conf ?? {};
    settings = sett ?? {};
    cache = {};
    state = {};
    try { if (savedState) state = JSON.parse(savedState) ?? {}; } catch (e) { state = {}; }
};

source.saveState = function () { return JSON.stringify(state); };

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
    cache.videoInfo = cache.videoInfo ?? {};
    cache.videoInfo[slug] = { id: v.id, duration: num(v.duration) ?? 0 };

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

// ---------------------------------------------------------------------------
// Comments (videos and screeds). MDE.tv returns 10 per page, newest first,
// with replies included on each comment.
// ---------------------------------------------------------------------------

source.getComments = function (url) {
    let m = REGEX_VIDEO.exec(url ?? "");
    if (m) {
        const id = videoIdForSlug(m[2]);
        return new MdeCommentPager("/videos/" + id + "/comments", url, 0);
    }
    m = REGEX_POST.exec(url ?? "");
    if (m) return new MdeCommentPager("/comments/" + m[1], url, 0);
    return new CommentPager([], false, {});
};

source.getSubComments = function (comment) {
    let replies = [];
    try { replies = JSON.parse(comment.context?.replies ?? "[]"); } catch (e) { }
    return new CommentPager(replies.map(r => toPlatformComment(r, comment.contextUrl, true)), false, {});
};

class MdeCommentPager extends CommentPager {
    constructor(path, contextUrl, page) {
        const j = apiGetJson(path + "?page=" + page + "&sort_by=created_at&sort_order=desc");
        const list = [];
        // Pinned comments go first, on the first page only
        if (page === 0) for (const c of (j.pinnedComments ?? [])) list.push(toPlatformComment(c, contextUrl, false, true));
        const pinnedIds = {};
        for (const c of (j.pinnedComments ?? [])) pinnedIds[c.id] = 1;
        for (const c of (j.comments ?? [])) if (!pinnedIds[c.id]) list.push(toPlatformComment(c, contextUrl, false));
        const shown = (page + 1) * 10;
        super(list, (j.comments ?? []).length > 0 && shown < (j.total ?? 0), { path: path, page: page });
        this.path = path;
        this.contextUrl = contextUrl;
        this.page = page;
    }
    nextPage() { return new MdeCommentPager(this.path, this.contextUrl, this.page + 1); }
}

function toPlatformComment(c, contextUrl, isReply, pinned) {
    const u = c.user ?? {};
    let message = c.message ?? "";
    if (c.gif) message += (message ? "\n" : "") + "[GIF] " + (typeof c.gif === "string" ? c.gif : (c.gif.url ?? ""));
    if (pinned) message = "📌 " + message;
    const replies = isReply ? [] : (c.replies ?? []);
    return new Comment({
        contextUrl: contextUrl,
        author: new PlatformAuthorLink(
            new PlatformID(PLATFORM, u.id ?? "", config.id),
            u.display_name ?? "Anonymous",
            "",
            u.photo ?? LOGO),
        message: message,
        rating: new RatingLikesDislikes(num(c.likes) ?? 0, num(c.dislikes) ?? 0),
        date: toUnix(c.created_at) ?? 0,
        replyCount: replies.length,
        context: { id: c.id ?? "", replies: JSON.stringify(replies) }
    });
}

function videoIdForSlug(slug) {
    const known = cache.videoInfo?.[slug];
    if (known) return known.id;
    const v = apiGetJson("/videos/" + slug).video;
    cache.videoInfo = cache.videoInfo ?? {};
    cache.videoInfo[slug] = { id: v.id, duration: num(v.duration) ?? 0 };
    return v.id;
}

// ---------------------------------------------------------------------------
// Watch sync: tells MDE.tv what you watched in Grayjay (same calls the site's
// player makes). Only active while logged in.
// ---------------------------------------------------------------------------

source.getPlaybackTracker = function (url) {
    if (!bridge.isLoggedIn()) return null;
    if (settings.syncWatched === false || settings.syncWatched === "false") return null;
    const m = REGEX_VIDEO.exec(url ?? "");
    if (!m) return null;
    let info = cache.videoInfo?.[m[2]];
    if (!info) {
        try {
            const v = apiGetJson("/videos/" + m[2]).video;
            info = { id: v.id, duration: num(v.duration) ?? 0 };
        } catch (e) { return null; }
    }
    return new MdePlaybackTracker(info.id, info.duration);
};

// A port of the website player's playback tracker. MDE.tv's achievements
// (watch time, finished episodes, binges, late-night viewing, ...) are worked
// out on the server from these playback reports, so sending the same reports
// from Grayjay makes Grayjay viewing count.
//
// Rules copied from the site:
//  - samples ~1s apart; a sample only counts if real time moved < 2.5s and the
//    position moved forward at a plausible speed (so seeks/pauses don't count)
//  - "qualified" after min(30s, half the video) of real watching
//  - "completed" once 90% of the video's length has actually been watched
//  - the episode is marked finished once playback passes 95% (or it ends)
//  - a new session starts after 30 min idle, 6 h total, or 500 watched ranges
class MdePlaybackTracker extends PlaybackTracker {
    constructor(videoId, duration) {
        super(1000);
        this.videoId = videoId;
        this.duration = duration;
        this.snap = null;       // current session snapshot (what gets sent)
        this.prev = null;       // previous sample {position, at}
        this.lastSentKey = "";
        this.lastFlushAt = Date.now();
        this.changes = 0;
        this.finishSent = false;
    }

    onInit(seconds) { this.prev = null; }

    onProgress(seconds, isPlaying) {
        if (!(this.duration > 0)) return;
        if (!isPlaying) { this.prev = null; this.maybeFlush(); return; }
        this.sample(seconds);
        if (!this.finishSent && seconds > Math.max(this.duration * 0.95, 10)) this.finish();
        this.maybeFlush();
    }

    onConcluded() {
        this.finish();
        this.flush();
        this.snap = null;
        this.prev = null;
    }

    sample(position) {
        const now = Date.now();
        const dur = this.duration;
        position = Math.max(0, Math.min(position, dur));
        const s = this.snap;
        if (s && (now - Date.parse(s.startedAt) >= 216e5 || now - Date.parse(s.lastAt) >= 18e5 || s.ranges.length >= 500)) {
            this.flush();
            this.snap = null;
            this.prev = null;
        }
        const prev = this.prev;
        this.prev = { position: position, at: now };
        if (!prev) return;

        const dt = (now - prev.at) / 1000;
        const dp = position - prev.position;
        if (dt <= 0 || dt > 2.5 || dp < 0 || dp > 4.25 * dt || dp < 0.2 * dt) {
            // Not normal playback: count it as a seek if the position jumped
            if (this.snap && Math.abs(dp) > 1 && (dp < 0 || dp > 4.25 * dt)) {
                const k = dp > 0 ? "forwardSeeks" : "backwardSeeks";
                this.snap.interactions[k] = Math.min(1e4, this.snap.interactions[k] + 1);
                this.changes++;
            }
            return;
        }

        if (!this.snap) this.snap = newSnapshot(this.videoId, dur, prev.at, now);
        const r = this.snap;
        r.duration = dur;
        r.lastAt = new Date(now).toISOString();
        r.watchSeconds += dt;

        const before = sumRanges(r.ranges);
        this.changes++;
        r.ranges = mergeRanges(r.ranges, [prev.position, position]);
        const after = sumRanges(r.ranges);
        r.interactions.rewatchedSeconds += dt * Math.max(0, Math.min(1, (dp - (after - before)) / dp));

        // Per-hour buckets (UTC hour start)
        let b = prev.at;
        while (b < now) {
            const hStart = 36e5 * Math.floor(b / 36e5);
            const hKey = new Date(hStart).toISOString();
            const end = Math.min(now, hStart + 36e5);
            let h = r.hours.find(x => x.hour === hKey);
            if (!h) { h = { hour: hKey, watchSeconds: 0 }; r.hours.push(h); }
            h.watchSeconds += (end - b) / 1000;
            b = end;
        }
        // Per-day buckets with a 100-slot heatmap of where in the video time was spent
        let k = prev.at;
        while (k < now) {
            const day = new Date(k).toISOString().slice(0, 10);
            const end = Math.min(now, Date.parse(day + "T00:00:00Z") + 864e5);
            const secs = (end - k) / 1000;
            let d = r.days.find(x => x.day === day);
            if (!d) { d = { day: day, watchSeconds: 0, positionSeconds: new Array(100).fill(0) }; r.days.push(d); }
            d.watchSeconds += secs;
            const p0 = prev.position + dp * ((k - prev.at) / (now - prev.at));
            const p1 = prev.position + dp * ((end - prev.at) / (now - prev.at));
            for (let i = Math.min(99, Math.floor(p0 / dur * 100)); i < 100; i++) {
                const lo = Math.max(p0, i * dur / 100), hi = Math.min(p1, (i + 1) * dur / 100);
                if (hi > lo) d.positionSeconds[i] += secs * (hi - lo) / (p1 - p0);
                if (hi >= p1) break;
            }
            k = end;
        }

        if (!r.qualifiedAt && r.watchSeconds >= Math.min(30, dur / 2)) r.qualifiedAt = r.lastAt;
        if (!r.completedAt && sumRanges(r.ranges) >= 0.9 * dur) r.completedAt = r.lastAt;
    }

    // The site sends every 60s; Grayjay has no "player closed" hook, so send
    // a little more often so less is lost when you back out of a video.
    maybeFlush() {
        if (Date.now() - this.lastFlushAt >= 20000) this.flush();
    }

    flush() {
        this.lastFlushAt = Date.now();
        const r = this.snap;
        if (!r || !(r.watchSeconds > 0)) return;
        const key = r.sessionId + ":" + r.lastAt + ":" + this.changes;
        if (key === this.lastSentKey) return;
        this.lastSentKey = key;
        r.sequence++;
        const body = Object.assign(JSON.parse(JSON.stringify(r)), {
            discovery: { source: "unknown", device: "mobile" },
            rewards: { visitId: visitId() },
            silver: { startedBy: "user" }
        });
        try {
            const resp = http.POST(apiUrl("/analytics/playback"), JSON.stringify(body),
                Object.assign(apiHeaders(), { "Content-Type": "application/json" }), true);
            debug("playback report #" + r.sequence + " (" + Math.round(r.watchSeconds) + "s watched) -> HTTP " + resp.code);
        } catch (e) { log("playback report failed: " + e); }
    }

    finish() {
        if (this.finishSent) return;
        this.finishSent = true; // don't retry on every tick if the call fails
        postWatch(this.videoId, "finish");
    }
}

function newSnapshot(videoId, duration, startAt, now) {
    return {
        version: 1,
        sessionId: uuid(),
        anonymousId: anonymousId(),
        userId: currentUserId(),
        videoId: videoId,
        contentKind: "video",
        platform: "web",
        sequence: 0,
        startedAt: new Date(startAt).toISOString(),
        lastAt: new Date(now).toISOString(),
        duration: duration,
        watchSeconds: 0,
        ranges: [],
        days: [],
        hours: [],
        interactions: { forwardSeeks: 0, backwardSeeks: 0, rewatchedSeconds: 0, exitedAt: null, exitPosition: null },
        qualifiedAt: null,
        completedAt: null
    };
}

function mergeRanges(ranges, add) {
    const out = [];
    for (const a of ranges.concat([add]).sort((x, y) => x[0] - y[0])) {
        const last = out[out.length - 1];
        if (last && a[0] <= last[1]) last[1] = Math.max(last[1], a[1]);
        else out.push([a[0], a[1]]);
    }
    return out;
}
function sumRanges(ranges) { return ranges.reduce((t, r) => t + r[1] - r[0], 0); }

function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.floor(16 * Math.random());
        return (c === "x" ? r : (r & 3) | 8).toString(16);
    });
}

// Stays the same across app restarts (saved with the plugin's state)
function anonymousId() {
    if (!state.anonymousId) state.anonymousId = uuid();
    return state.anonymousId;
}
// One "visit" per time the plugin is loaded, like a browser tab session
function visitId() {
    if (!cache.visitId) cache.visitId = uuid();
    return cache.visitId;
}
function currentUserId() {
    if (cache.userId !== undefined) return cache.userId;
    try { cache.userId = apiGetJson("/auth").user?.id ?? null; }
    catch (e) { cache.userId = null; }
    return cache.userId;
}

function postWatch(videoId, action) {
    try {
        const r = http.POST(apiUrl("/videos/" + videoId + "/" + action), "", apiHeaders(), true);
        debug("POST /videos/" + videoId + "/" + action + " -> HTTP " + r.code);
        return r.isOk;
    } catch (e) {
        log("watch sync failed: " + e);
        return false;
    }
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
    // Videos marked watched on the website show as watched in Grayjay
    const watched = v.watched === true;
    return new PlatformVideo({
        playbackTime: watched ? Math.round(num(v.duration) ?? 1) : -1,
        playbackDate: watched ? (toUnix(v.published_at ?? v.created_at) ?? undefined) : undefined,
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
