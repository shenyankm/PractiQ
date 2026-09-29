//! Explicit public-URL and QR imports. Downloads become ordinary local audio assets.
use crate::{contract::Result, language::error, AppError};
use dom_query::Document;
use reqwest::{blocking::Client, header, redirect::Policy};
use serde::Serialize;
use serde_json::json;
use std::{
    io::{Cursor, Read},
    net::{IpAddr, ToSocketAddrs},
    time::{Duration, Instant},
};
use url::Url;

const PAGE_LIMIT: usize = 2 * 1024 * 1024;
const MAX_LINKS: usize = 50;
#[derive(Serialize)]
pub struct Link {
    pub url: String,
    pub label: String,
}
pub enum Download {
    Audio(Vec<u8>),
    Links(Vec<Link>),
}
fn failure(code: &str) -> AppError {
    error(code, json!({}))
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_documentation()
                || a == 0
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 192 && ((b == 0 && c == 0) || (b == 88 && c == 99)))
                || (a == 198 && (18..=19).contains(&b)))
        }
        // Only global unicast, excluding protocol assignments, 6to4 and documentation.
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001 && (s[1] < 0x200 || s[1] == 0xdb8))
                && s[0] != 0x2002
                && !(s[0] == 0x3fff && s[1] < 0x1000)
        }
    }
}
fn public_url(raw: &str) -> Result<Url> {
    if raw.len() > 8192 {
        return Err(failure("LOCAL_AUDIO_URL_INVALID"));
    }
    let mut url = Url::parse(raw.trim()).map_err(|_| failure("LOCAL_AUDIO_URL_INVALID"))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || !matches!(url.port_or_known_default(), Some(80 | 443))
    {
        return Err(failure("LOCAL_AUDIO_URL_INVALID"));
    }
    match url.host() {
        Some(url::Host::Ipv4(ip)) if public_ip(ip.into()) => (),
        Some(url::Host::Ipv6(ip)) if public_ip(ip.into()) => (),
        Some(url::Host::Domain(host))
            if host.contains('.')
                && !host.trim_end_matches('.').ends_with(".localhost")
                && host.trim_end_matches('.') != "localhost"
                && !host.trim_end_matches('.').ends_with(".local") => {}
        _ => return Err(failure("LOCAL_AUDIO_URL_INVALID")),
    }
    url.set_fragment(None);
    Ok(url)
}
fn push_link(links: &mut Vec<Link>, base: &Url, value: &str, label: &str) {
    if value.trim().is_empty() || links.len() >= MAX_LINKS {
        return;
    }
    let Ok(joined) = base.join(value.trim()) else {
        return;
    };
    let Ok(url) = public_url(joined.as_str()) else {
        return;
    };
    if !links.iter().any(|l| l.url == url.as_str()) {
        links.push(Link {
            url: url.to_string(),
            label: label.trim().chars().take(160).collect(),
        });
    }
}
fn page_links(bytes: &[u8], url: &Url) -> Result<Vec<Link>> {
    if bytes.len() > PAGE_LIMIT {
        return Err(failure("LOCAL_AUDIO_DOWNLOAD_SIZE"));
    }
    // Resource attributes are decoded by an HTML parser; scripts are never evaluated.
    let html = Document::from(String::from_utf8_lossy(bytes).as_ref());
    let base = html
        .select("base[href]")
        .first()
        .attr("href")
        .and_then(|href| url.join(&href).ok())
        .filter(|u| public_url(u.as_str()).is_ok())
        .unwrap_or_else(|| url.clone());
    let mut links = Vec::new();
    for element in html.select("audio[src], audio source[src], a[href], meta[property='og:audio'], meta[property='og:audio:url'], meta[property='og:audio:secure_url']").nodes() {
        let node = element;
        let value = node.attr("src").or_else(|| node.attr("href")).or_else(|| node.attr("content")).unwrap_or_default();
        if node.has_name("a") && !base.join(&value).is_ok_and(|u| {
            let path = u.path().to_ascii_lowercase();
            [".mp3", ".m4a", ".aac", ".wav"].iter().any(|ext| path.ends_with(ext))
        }) { continue; }
        let label = element.text();
        push_link(&mut links, &base, &value, &label);
    }
    if links.is_empty() {
        return Err(failure("LOCAL_AUDIO_NO_LINKS"));
    }
    Ok(links)
}
fn bounded_body(reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader
        .take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?;
    if bytes.len() > limit {
        return Err(failure("LOCAL_AUDIO_DOWNLOAD_SIZE"));
    }
    Ok(bytes)
}
pub fn download(raw: &str) -> Result<Download> {
    let mut url = public_url(raw)?;
    let deadline = Instant::now() + Duration::from_secs(45);
    for hop in 0..=5 {
        let host = url
            .host_str()
            .ok_or_else(|| failure("LOCAL_AUDIO_URL_INVALID"))?;
        let addresses: Vec<_> = match url.host() {
            Some(url::Host::Ipv4(ip)) => {
                vec![(IpAddr::V4(ip), url.port_or_known_default().unwrap()).into()]
            }
            Some(url::Host::Ipv6(ip)) => {
                vec![(IpAddr::V6(ip), url.port_or_known_default().unwrap()).into()]
            }
            _ => (host, url.port_or_known_default().unwrap())
                .to_socket_addrs()
                .map_err(|_| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?
                .take(32)
                .collect(),
        };
        if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
            return Err(failure("LOCAL_AUDIO_URL_INVALID"));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?;
        // Pin validated DNS answers, disable proxies and validate every redirect independently.
        let client = Client::builder()
            .no_proxy()
            .redirect(Policy::none())
            .resolve_to_addrs(host, &addresses)
            .timeout(remaining)
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?;
        let response = client
            .get(url.clone())
            .header(header::ACCEPT_ENCODING, "identity")
            .header(header::ACCEPT, "audio/*, text/html;q=0.9, */*;q=0.1")
            .send()
            .map_err(|_| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?;
        if response.status().is_redirection() {
            if hop == 5 {
                return Err(failure("LOCAL_AUDIO_DOWNLOAD_FAILED"));
            }
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))?;
            url = public_url(
                url.join(location)
                    .map_err(|_| failure("LOCAL_AUDIO_URL_INVALID"))?
                    .as_str(),
            )?;
            continue;
        }
        if !response.status().is_success() {
            return Err(failure("LOCAL_AUDIO_DOWNLOAD_FAILED"));
        }
        let is_html = response
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("text/html") || v.starts_with("application/xhtml+xml"));
        let limit = if is_html {
            PAGE_LIMIT
        } else {
            crate::assets::LIMIT
        };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(failure("LOCAL_AUDIO_DOWNLOAD_SIZE"));
        }
        let bytes = bounded_body(response, limit)?;
        let prefix = String::from_utf8_lossy(&bytes[..bytes.len().min(256)])
            .trim_start()
            .to_ascii_lowercase();
        if is_html || prefix.starts_with("<!doctype html") || prefix.starts_with("<html") {
            return page_links(&bytes, &url).map(Download::Links);
        }
        return Ok(Download::Audio(bytes));
    }
    Err(failure("LOCAL_AUDIO_DOWNLOAD_FAILED"))
}

pub fn qr_links(bytes: &[u8]) -> Result<Vec<Link>> {
    if bytes.len() > crate::assets::LIMIT {
        return Err(failure("LOCAL_AUDIO_QR_INVALID"));
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| failure("LOCAL_AUDIO_QR_INVALID"))?;
    if !matches!(
        reader.format(),
        Some(image::ImageFormat::Png | image::ImageFormat::Jpeg)
    ) {
        return Err(failure("LOCAL_AUDIO_QR_INVALID"));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|_| failure("LOCAL_AUDIO_QR_INVALID"))?
        .to_luma8();
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(
        img.width() as usize,
        img.height() as usize,
        |x, y| img.get_pixel(x as u32, y as u32)[0],
    );
    let mut links = Vec::new();
    for grid in prepared.detect_grids() {
        if let Ok((_, content)) = grid.decode() {
            if let Ok(url) = public_url(&content) {
                push_link(&mut links, &url, url.as_str(), "");
            }
        }
    }
    if links.is_empty() {
        return Err(failure("LOCAL_AUDIO_QR_INVALID"));
    }
    Ok(links)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_destinations_and_non_web_urls() {
        for raw in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ftp://example.com/a",
            "https://user:secret@example.com/a",
            "http://example.com:8080/a",
            "http://localhost/a",
            "http://localhost./a",
            "http://127.1/a",
            "http://2130706433/a",
            "http://10.0.0.1/a",
            "http://169.254.169.254/a",
            "http://100.64.0.1/a",
            "http://192.0.0.1/a",
            "http://192.88.99.1/a",
            "http://198.18.0.1/a",
            "http://224.0.0.1/a",
            "http://240.0.0.1/a",
            "http://[::1]/a",
            "http://[::ffff:127.0.0.1]/a",
            "http://[fc00::1]/a",
            "http://[2002:7f00:1::]/a",
            "http://[2001:db8::1]/a",
        ] {
            assert!(public_url(raw).is_err(), "{raw}");
        }
        for raw in [
            "https://example.com/a",
            "http://8.8.8.8/a",
            "https://[2606:4700::1111]/a",
        ] {
            assert!(public_url(raw).is_ok(), "{raw}");
        }
        // Invalid direct imports must fail before making a connection.
        assert!(download("http://127.0.0.1/secret").is_err());
        let base = public_url("https://example.com/audio").unwrap();
        assert!(public_url(base.join("http://10.0.0.1/secret").unwrap().as_str()).is_err());
    }
    #[test]
    fn extracts_public_audio_links_without_executing_page_content() {
        let url = public_url("https://example.com/page").unwrap();
        let links = page_links(
            br#"<base href="/media/">
            <audio src="track.mp3?x=1&amp;y=2"></audio>
            <audio><source src="../second"></audio>
            <a href="track.mp3?x=1&amp;y=2">Duplicate</a>
            <a href="third.WAV">Track three</a>
            <a href="https://127.0.0.1/private.mp3">Private</a>
            <a href="javascript:alert(1)">Script</a>
            <meta property="og:audio" content="//cdn.example.com/fourth">
            <script>fetch("https://example.com/hidden.mp3")</script>"#,
            &url,
        )
        .unwrap();
        assert_eq!(
            links.iter().map(|l| l.url.as_str()).collect::<Vec<_>>(),
            [
                "https://example.com/media/track.mp3?x=1&y=2",
                "https://example.com/second",
                "https://example.com/media/third.WAV",
                "https://cdn.example.com/fourth",
            ]
        );
        assert_eq!(links[2].label, "Track three");
        assert!(page_links(b"<script>playAudio()</script>", &url).is_err());
        assert!(page_links(&vec![b' '; PAGE_LIMIT + 1], &url).is_err());
        let many = (0..100)
            .map(|i| format!("<audio src='/{i}.mp3'>"))
            .collect::<String>();
        assert_eq!(page_links(many.as_bytes(), &url).unwrap().len(), MAX_LINKS);
    }
    #[test]
    fn limits_reads_without_trusting_content_length() {
        assert_eq!(bounded_body(Cursor::new(b"1234"), 4).unwrap(), b"1234");
        assert!(bounded_body(Cursor::new(b"12345"), 4).is_err());
    }
    #[test]
    fn decodes_qr_image_and_rejects_invalid_or_oversized_images() {
        let bytes = include_bytes!("../../fixtures/listening-qr.png");
        let links = qr_links(bytes).unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].url, "https://example.com/listening.wav");
        assert!(qr_links(b"not an image").is_err());
        let image = image::GrayImage::new(4097, 1);
        let mut data = Cursor::new(Vec::new());
        image.write_to(&mut data, image::ImageFormat::Png).unwrap();
        assert!(qr_links(data.get_ref()).is_err());
    }
    #[test]
    fn removed_image_formats_are_rejected_even_if_mislabeled() {
        use base64::Engine;
        for encoded in ["R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7","UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoCAAIAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA="] {
            let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
            assert!(qr_links(&bytes).is_err());
            for media in ["image/gif", "image/webp", "image/png", "image/jpeg"] {
                assert!(!crate::store::valid_image(&bytes, media));
            }
        }
    }
    #[test]
    fn downloaded_audio_uses_local_validation_and_staging() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::store::Store::new(dir.path().to_path_buf()).unwrap();
        let bytes = include_bytes!("../../fixtures/resources/audio/chimes.wav");
        let staged = store.stage_audio_bytes(bytes.to_vec()).unwrap();
        let hash = staged["reference"]["sha256"].as_str().unwrap();
        assert_eq!(store.asset_bytes(hash).unwrap().unwrap().1, bytes);
        assert_eq!(staged["reference"]["mediaType"], "audio/wav");
        assert!(staged["duration"].as_f64().unwrap() > 0.0);
        assert!(store
            .stage_audio_bytes(b"<html>Login required</html>".to_vec())
            .is_err());
        assert!(store
            .stage_audio_bytes(vec![0; crate::assets::LIMIT + 1])
            .is_err());
        assert_eq!(store.staged_audio.len(), 1);
    }
}
