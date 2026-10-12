// FTP directory listing parsers: Unix `ls -l` style, DOS/Windows style,
// and MLSD/MLST machine format (RFC 3659).
//
// Pure code (no JS calls except the `now_ms` used for Unix-listing year
// inference), so it is unit-testable on the host target with `cargo test`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// milliseconds since Unix epoch (best-effort)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<i64>,
    /// mode string as reported (e.g. "drwxr-xr-x" or "644")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// symlink target
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    pub raw: String,
}

fn entry(name: &str, raw: &str) -> Entry {
    Entry {
        name: name.to_string(),
        dir: false,
        size: None,
        mtime: None,
        mode: None,
        link: None,
        raw: raw.to_string(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ListKind {
    /// `LIST` output — sniff flavor
    Auto,
    Unix,
    Dos,
    Mlsd,
    /// `NLST` — bare names
    Names,
}

/// Parse a whole listing body. Unparsable lines are skipped, not fatal.
pub fn parse_listing(body: &str, kind: ListKind, now_ms: i64) -> Vec<Entry> {
    let mut entries = Vec::new();
    for raw in body.lines() {
        let line = raw.trim_end_matches('\r').trim_end_matches('\n');
        let t = line.trim();
        if t.is_empty() || t.starts_with("total ") || t.starts_with("Total ") {
            continue;
        }
        let k = match kind {
            ListKind::Auto => detect_kind(t),
            k => k,
        };
        match k {
            ListKind::Unix => {
                if t.starts_with("total") || t.starts_with("Total") {
                    continue;
                }
                if let Some(e) = parse_unix_line(t, now_ms) {
                    entries.push(e);
                }
            }
            ListKind::Dos => {
                if let Some(e) = parse_dos_line(t) {
                    entries.push(e);
                }
            }
            ListKind::Mlsd => {
                if let Some(e) = parse_mlsx_line(t) {
                    entries.push(e);
                }
            }
            ListKind::Names => entries.push(entry(t, line)),
            ListKind::Auto => {}
        }
    }
    entries
}

/// Sniff one line's flavor (MLSD facts > unix perms > dos date > names).
pub fn detect_kind(line: &str) -> ListKind {
    if line.contains(';') && (line.contains("type=") || line.contains("; ")) {
        return ListKind::Mlsd;
    }
    if unix_line_shape(line) {
        return ListKind::Unix;
    }
    if dos_line_shape(line) {
        return ListKind::Dos;
    }
    ListKind::Names
}

fn unix_line_shape(line: &str) -> bool {
    let b = line.as_bytes();
    if b.len() < 10 {
        return false;
    }
    match b[0] {
        b'd' | b'-' | b'l' => {}
        _ => return false,
    }
    // positions 1..9 should be permission-ish chars (+ potential trailing bits)
    b[1..10].iter().all(|c| {
        matches!(*c, b'r' | b'w' | b'x' | b'S' | b's' | b'T' | b't' | b'-' | b' ')
    }) && b.iter().all(|c| c.is_ascii())
}

fn dos_line_shape(line: &str) -> bool {
    let mut it = line.split_whitespace();
    let (Some(date), Some(time)) = (it.next(), it.next()) else {
        return false;
    };
    let dp: Vec<&str> = date.split(['-', '.', '/']).collect();
    dp.len() == 3
        && dp.iter().all(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
        && (time.ends_with("AM")
            || time.ends_with("PM")
            || time.contains(':') && time.chars().all(|c| c.is_ascii_digit() || c == ':'))
}

// ---------------------------------------------------------------
// Unix `ls -l`
// ---------------------------------------------------------------

const MONTHS: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];

pub fn parse_unix_line(line: &str, now_ms: i64) -> Option<Entry> {
    let b = line.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let ftype = match b[0] {
        b'd' => 'd',
        b'-' | b'c' | b'b' | b's' | b'p' => '-',
        b'l' => 'l',
        _ => return None,
    };
    if !b[1..10].iter().all(|c| {
        matches!(*c, b'r' | b'w' | b'x' | b'S' | b's' | b'T' | b't' | b'-')
    }) {
        return None;
    }
    let mode = line[..10].to_string();
    let parts: Vec<&str> = line[10..].split_whitespace().collect();
    if parts.len() < 4 {
        return None;
    }
    // find date triplet: [month-abbr, day-num, hh:mm | year]
    let mut date_idx = None;
    for i in 0..parts.len().saturating_sub(2) {
        let is_month = MONTHS.iter().any(|m| parts[i].eq_ignore_ascii_case(m));
        let is_day = !parts[i + 1].is_empty()
            && parts[i + 1].chars().all(|c| c.is_ascii_digit());
        if is_month && is_day {
            date_idx = Some(i);
            break;
        }
    }
    let di = date_idx?;
    if di == 0 || di + 3 > parts.len() {
        return None;
    }
    let size = parts[di - 1].parse::<u64>().ok();
    let mtime = parse_unix_time(parts[di], parts[di + 1], parts[di + 2], now_ms);
    let mut name = parts[di + 3..].join(" ");
    if name.is_empty() {
        return None;
    }
    let mut link = None;
    if ftype == 'l' {
        if let Some(idx) = name.find(" -> ") {
            link = Some(name[idx + 4..].trim().to_string());
            name.truncate(idx);
        }
    }
    let name = name.trim().to_string();
    if name.is_empty() || name == "." || name == ".." {
        return None;
    }
    let mut e = entry(&name, line);
    e.dir = ftype == 'd';
    e.size = if ftype == '-' { size } else { None };
    e.mtime = mtime;
    e.mode = Some(mode);
    e.link = link;
    Some(e)
}

/// `["Sep", "12", "10:00"]` or `["Mar", "1", "2023"]` -> epoch ms.
pub fn parse_unix_time(month: &str, day: &str, third: &str, now_ms: i64) -> Option<i64> {
    let m = MONTHS
        .iter()
        .position(|x| x.eq_ignore_ascii_case(month.trim()))? as u32;
    let d = day.trim().parse::<u32>().ok()?;
    let t = third.trim();
    if t.contains(':') {
        let tp: Vec<&str> = t.split(':').collect();
        let h = tp.first()?.parse::<u32>().ok()?;
        let mi = tp.get(1).copied().unwrap_or("0").parse::<u32>().unwrap_or(0);
        let s = tp.get(2).copied().unwrap_or("0").parse::<u32>().unwrap_or(0);
        // ls omits the year for files within ~6 months; future-dated means
        // the previous year.
        let year = year_for(now_ms);
        let ts = ymd_hms_to_epoch(year, m + 1, d, h, mi, s)?;
        if ts > now_ms + 48 * 3600 * 1000 {
            return ymd_hms_to_epoch(year - 1, m + 1, d, h, mi, s);
        }
        Some(ts)
    } else {
        let y = t.parse::<i32>().ok()?;
        ymd_hms_to_epoch(y, m + 1, d, 0, 0, 0)
    }
}

fn year_for(now_ms: i64) -> i32 {
    days_to_civil(now_ms.div_euclid(86_400_000)).0
}

// Howard Hinnant's civil_from_days: epoch days -> (y, m, d) UTC.
fn days_to_civil(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = if m <= 2 { y + 1 } else { y };
    (year as i32, m, d)
}

// civil_to_days inverse: (y, m, d, h, mi, s) UTC -> epoch ms; None if invalid.
fn ymd_hms_to_epoch(y: i32, m: u32, d: u32, h: u32, mi: u32, s: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y } as i64;
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some((days * 86_400 + h as i64 * 3600 + mi as i64 * 60 + s as i64) * 1000)
}

// ---------------------------------------------------------------
// DOS / IIS
// ---------------------------------------------------------------

pub fn parse_dos_line(line: &str) -> Option<Entry> {
    let mut it = line.split_whitespace();
    let date = it.next()?;
    let time = it.next()?;
    let size_tok = it.next()?;
    let name = it.collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return None;
    }
    let up = size_tok.to_ascii_uppercase();
    let is_dir = up.contains("DIR") || up.contains("JUNCTION");
    let size = if is_dir { None } else { size_tok.parse::<u64>().ok() };
    let mtime = parse_dos_time(date, time);
    let mut e = entry(&name, line);
    e.dir = is_dir;
    e.size = size;
    e.mtime = mtime;
    Some(e)
}

/// `09-12-26` / `2026-09-12` / `03-12-2026` + `10:00AM` / `13:45:02`.
pub fn parse_dos_time(date: &str, time: &str) -> Option<i64> {
    let p: Vec<&str> = date.split(['-', '.', '/']).collect();
    let nums: Vec<u32> = p.iter().filter_map(|s| s.parse::<u32>().ok()).collect();
    if nums.len() != 3 {
        return None;
    }
    let (a, b, c) = (nums[0], nums[1], nums[2]);
    let (year, month, day) = if a > 31 {
        // yyyy-mm-dd
        (a as i32, b, c)
    } else if c > 31 {
        // dd-mm-yyyy (or mm-dd-yyyy; dd-first is the common two-digit style)
        (c as i32, b, a)
    } else {
        // yy-mm-dd two-digit year
        let y = (if a >= 70 { 1900 } else { 2000 }) + a as i32;
        (y, b, c)
    };
    let mut t = time.trim().to_ascii_lowercase();
    let mut pm = false;
    let mut am = false;
    if t.ends_with("am") {
        am = true;
        t.truncate(t.len() - 2);
    } else if t.ends_with("pm") {
        pm = true;
        t.truncate(t.len() - 2);
    }
    let tp: Vec<&str> = t.split(':').collect();
    let h = tp.first()?.parse::<u32>().ok()?;
    let mi = tp.get(1).copied().unwrap_or("0").parse::<u32>().unwrap_or(0);
    let s = tp.get(2).copied().unwrap_or("0").parse::<u32>().unwrap_or(0);
    let h24 = if pm && h < 12 {
        h + 12
    } else if am && h == 12 {
        0
    } else {
        h
    };
    ymd_hms_to_epoch(year, month, day, h24, mi, s)
}

// ---------------------------------------------------------------
// MLSD / MLST
// ---------------------------------------------------------------

/// `type=file;size=1024;modify=20230912101234;UNIX.mode=0644; report.pdf`
pub fn parse_mlsx_line(line: &str) -> Option<Entry> {
    // Facts are `k=v;` list followed by exactly one space, then the name.
    // Use the LAST `;` + space as the separator so names with spaces work;
    // fall back to the last space for servers that omit the trailing `;`.
    let last_semi = line.rfind(';')?;
    let (facts, name) = if line.as_bytes().get(last_semi + 1) == Some(&b' ') {
        (&line[..=last_semi], &line[last_semi + 2..])
    } else {
        let space = line.rfind(' ')?;
        (line[..space].trim(), line[space..].trim())
    };
    let name = name.trim();
    if name.is_empty() || !facts.contains(';') {
        return None;
    }
    let mut e = entry(name, line);
    for fact in facts.trim().split(';') {
        let fact = fact.trim();
        if fact.is_empty() {
            continue;
        }
        let eq = fact.find('=')?;
        let k = fact[..eq].to_ascii_lowercase();
        let v = fact[eq + 1..].trim().to_string();
        match k.as_str() {
            "type" => {
                let t = v.to_ascii_lowercase();
                e.dir = t == "dir" || t == "cdir" || t == "pdir";
            }
            "size" => e.size = v.parse::<u64>().ok(),
            "modify" => e.mtime = mlsx_time(&v).or(e.mtime),
            "create" if e.mtime.is_none() => e.mtime = mlsx_time(&v),
            "unix.mode" => e.mode = Some(v.trim_start_matches('0').to_string()),
            _ => {}
        }
    }
    Some(e)
}

/// `20230912101234` (optional `.fraction`) -> epoch ms (UTC assumed).
pub fn mlsx_time(v: &str) -> Option<i64> {
    let digits: String = v.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 14 {
        return None;
    }
    let n = |a: usize, b: usize| digits[a..b].parse::<u32>().ok();
    let y = digits[0..4].parse::<i32>().ok()?;
    let mo = n(4, 6)?;
    let d = n(6, 8)?;
    let h = n(8, 10)?;
    let mi = n(10, 12)?;
    let s = n(12, 14)?;
    ymd_hms_to_epoch(y, mo, d, h, mi, s)
}

// ---------------------------------------------------------------
// MDTM / MFMT helpers
// ---------------------------------------------------------------

/// `MDTM` reply: `213 20230912101234` -> epoch ms.
pub fn parse_mdtm_reply(reply: &crate::ftp::control::Reply) -> Option<i64> {
    let text = reply.text();
    let mut it = text.split_whitespace();
    let _code = it.next()?;
    mlsx_time(it.next()?)
}

/// MFMT request stamp: epoch ms -> `YYYYMMDDHHMMSS`.
pub fn format_mfmt(mtime_ms: i64) -> String {
    let secs = mtime_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, mo, d) = days_to_civil(days);
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}",
        y,
        mo,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}
