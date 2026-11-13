/**
 * 설명회 접수데스크 ↔ 구글 시트 연동 (별도 Apps Script 프로젝트)
 *
 * 설치
 *  1) script.google.com → 새 프로젝트 → 이 코드를 전부 붙여넣기
 *  2) 아래 SHEET_ID, API_KEY 입력
 *  3) 배포 → 새 배포 → 유형: 웹 앱 / 실행: 나 / 액세스 권한: 모든 사용자 → 배포 → 권한 승인
 *  4) 나온 웹 앱 URL과 API_KEY를 접수데스크 [설정 → 구글 시트 연동]에 입력
 *
 * 기존 신청 페이지 프로젝트는 건드리지 않습니다. 이 프로젝트는 명단을 읽기만 하고,
 * 참석 기록은 같은 스프레드시트의 새 탭(참석기록·승인·현장신청·데스크설정)에 저장합니다.
 */
const SHEET_ID = '여기에_스프레드시트_ID';   // 시트 주소 .../spreadsheets/d/【이 부분】/edit
const API_KEY  = '여기에_비밀키';            // 영문·숫자를 섞어 16자 이상 권장
const MAIL_FROM = 'info@rndhelp.co.kr';      // 확인증 메일 발신 주소 (아래 mailMode_ 설명 참고)
const CERT_FILE = '[태성회계법인] 정산설명회_참석확인증_';   // 첨부파일 이름 앞부분 (뒤에 성명이 붙음)
const SURVEY_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdgElv5xupD6McmsHbCVGu5Qmn1u81wVzxgjryF2YlcQEeeRg/viewform';  // 만족도 조사 (비우면 안내 생략)

// 각 탭: 사람이 읽는 열들 + [updatedAt, deleted, data(JSON 원본)]
const TABLES = {
  attend: {
    name: '참석기록',
    cols: ['id', '회차', '접수번호', '성명', '기관', '과제번호', '휴대폰번호', '참석시각', '데스크', '구분'],
    idOf: r => r.id,
    row: r => [r.id, r.session, r.receiptNo, r.name, r.org, r.projectNo, r.phone, r.checkinAt, r.desk,
               r.source === 'walkin' ? '현장접수'
                 : r.source === 'waitlist' ? '신청대기 (' + (r.seq || '?') + '번' + (r.appliedSession && r.appliedSession !== r.session ? ', 원래 신청: ' + r.appliedSession : '') + ')'
                 : r.source === 'other' ? '정원 내 · 타 회차 승인 (원래 신청: ' + (r.appliedSession || '미확인') + ')' : '정원 내'],
  },
  approvals: {
    name: '승인',
    cols: ['id', '회차', '접수번호', '성명', '기관', '신청회차', '현장신청', '상태', '요청시각', '처리시각', '데스크'],
    idOf: r => r.id,
    row: r => [r.id, r.session, r.receiptNo, r.name, r.org, r.appliedSession, r.walkin ? 'Y' : r.waitlist ? '대기 ' + (r.seq || '') + '번' : '',
               r.status, r.requestedAt, r.decidedAt, r.desk],
  },
  walkins: {
    name: '현장신청',
    cols: ['id', '회차', '성명', '기관', '과제번호', '휴대폰번호', '신청시각', '데스크'],
    idOf: r => r.receiptNo,
    row: r => [r.receiptNo, r.session, r.name, r.org, r.projectNo, r.phone, r.createdAt, r.desk],
  },
  settings: {
    name: '데스크설정',
    cols: ['id'],
    idOf: () => 'settings',
    row: () => ['settings'],
  },
};
const OWN_TABS = Object.keys(TABLES).map(k => TABLES[k].name);

/* ---------- 웹 앱 진입점 ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === 'cert') return out(certFor_(p.id, p.tk));   // 참석자 휴대폰 확인증 (비밀키 대신 기록별 열쇠로 확인)
  if (p.key !== API_KEY) return out({ ok: false, error: 'key' });
  if (p.action !== 'pull') return out({ ok: false, error: 'action' });
  const since = Number(p.since || 0);
  const o = {
    ok: true, now: Date.now(),
    attend: pullTable('attend', since),
    approvals: pullTable('approvals', since),
    walkins: pullTable('walkins', since),
  };
  const s = pullTable('settings', since)[0];
  if (s) o.settings = s;
  o.resetAt = getResetAt();
  if (p.full === '1') { o.applicants = readApplicants(); o.waitlist = readWaitlist(); }
  return out(o);
}

function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out({ ok: false, error: 'bad request' }); }
  if (b.key !== API_KEY) return out({ ok: false, error: 'key' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);                       // 여러 데스크 동시 접수 시 순서대로 처리
  try {
    // 전체 초기화 이전에 만들어진 기록이 늦게 도착하면 버림 (설정은 제외)
    if (b.ts && b.action !== 'settings' && b.action !== 'resetAll' && Number(b.ts) < getResetAt()) {
      return out({ ok: true, dropped: true });
    }
    switch (b.action) {
      case 'checkin': {                       // 같은 회차·같은 사람은 먼저 들어온 1건만 인정
        const ex = findRec('attend', b.rec.id);
        if (ex && !ex.deleted && ex.checkinISO !== b.rec.checkinISO) return out({ ok: false, exists: ex });
        upsert('attend', b.rec, false);
        return out({ ok: true });
      }
      case 'deleteAttend': {
        const ex = findRec('attend', b.id);
        if (ex) { delete ex.updatedAt; delete ex.deleted; upsert('attend', ex, true); }
        return out({ ok: true });
      }
      case 'approval': {                      // 이미 승인/거절된 건을 늦게 도착한 '대기' 요청이 덮어쓰지 않게
        const ex = findRec('approvals', b.rec.id);
        if (ex && b.rec.status === 'pending' && ex.status !== 'pending') return out({ ok: true, kept: ex.status });
        upsert('approvals', b.rec, false);
        return out({ ok: true });
      }
      case 'walkin':
        upsert('walkins', b.rec, false);
        return out({ ok: true });
      case 'settings':
        upsert('settings', b.data, false);
        return out({ ok: true });
      case 'resetAll': {                      // 참석기록·승인·현장신청 비우기 (명단·설정은 유지)
        ['attend', 'approvals', 'walkins'].forEach(k => {
          const sh = sheetOf(k);
          const last = sh.getLastRow();
          if (last > 1) sh.getRange(2, 1, last - 1, sh.getLastColumn()).clearContent();
        });
        const now = Date.now();
        PropertiesService.getScriptProperties().setProperty('resetAt', String(now));
        return out({ ok: true, resetAt: now });
      }
      case 'sendCert':
        return out(sendCert_(b));
      default:
        return out({ ok: false, error: 'action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 참석자 휴대폰 확인증용 서명·직인 ---------- */
// QR에 담긴 기록 번호(id)와 그 기록에만 있는 무작위 열쇠(tk)가 모두 맞을 때만 서명을 돌려줍니다.
function certFor_(id, tk) {
  if (!id || !tk || String(tk).length < 12) return { ok: false };
  const r = findRec('attend', String(id));
  if (!r || r.deleted || r.tk !== String(tk)) return { ok: false };
  const st = findRec('settings', 'settings');
  return { ok: true, sig: r.sig || '', stamp: (st && st.stamp) || '' };
}

/* ---------- 참석 확인증 이메일 ---------- */
// 이 Apps Script를 배포한 구글 계정 이름으로 발송됩니다. 하루 한도: 개인 Gmail 약 100통, Workspace 약 1,500통
function sendCert_(b) {
  const to = String(b.to || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: '이메일 주소 형식이 올바르지 않습니다.' };
  if (MailApp.getRemainingDailyQuota() < 1) return { ok: false, error: 'quota' };
  const h = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const m = String(b.img || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
  const attachments = m ? [Utilities.newBlob(Utilities.base64Decode(m[2]), 'image/' + m[1],
    CERT_FILE + String(b.name || '').replace(/[\\/:*?"<>|]/g, '') + (m[1] === 'png' ? '.png' : '.jpg'))] : [];
  const when = [b.sessionName, b.date, b.place].filter(String).join(' · ');
  const btn = (url, label, bg) => '<a href="' + h(url) + '" style="display:inline-block;padding:12px 22px;background:' + bg +
      ';color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">' + label + '</a>';
  const htmlBody =
      '<div style="font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif;font-size:15px;line-height:1.7;color:#16202c;max-width:560px">' +
      '<p><b>' + h(b.name) + '</b>님, <b>' + h(b.eventName) + '</b>에 참석해 주셔서 감사합니다.</p>' +
      (when ? '<p style="color:#555;margin-top:-6px">' + h(when) + '</p>' : '') +
      '<p>참석 확인증을 이 메일에 첨부해 드립니다.</p>' +
      (SURVEY_URL ?
        '<div style="margin:22px 0;padding:18px 20px;border:2px solid #1f5fbf;border-radius:12px;background:#f2f7ff">' +
        '<p style="margin:0 0 6px;font-size:17px;font-weight:bold;color:#1f5fbf">📝 만족도 조사에 참여해 주세요</p>' +
        '<p style="margin:0 0 14px">오늘 설명회는 어떠셨나요? 남겨 주신 의견은 다음 설명회를 더 알차게 준비하는 데 소중히 반영하겠습니다. ' +
        '잠시만 시간을 내어 참여해 주시면 큰 힘이 됩니다.</p>' +
        btn(SURVEY_URL, '만족도 조사 참여하기', '#1f5fbf') + '</div>' : '') +
      '<p style="color:#888;font-size:12px;margin-top:24px">문의: ' + h(MAIL_FROM) + '</p></div>';
  const subject = '[' + (b.eventName || '설명회') + '] 참석 확인증';
  const name = b.sender || b.eventName || '설명회 접수데스크';
  if (mailMode_() === 'alias') {
    GmailApp.sendEmail(to, subject, '참석 확인증을 첨부해 드립니다.', {
      from: MAIL_FROM, name: name, replyTo: MAIL_FROM, htmlBody: htmlBody, attachments: attachments });
  } else {
    MailApp.sendEmail({ to: to, subject: subject, name: name, htmlBody: htmlBody, attachments: attachments,
      replyTo: MAIL_FROM || undefined });
  }
  return { ok: true, left: MailApp.getRemainingDailyQuota() };
}

// 발신 주소 결정
//  - 이 스크립트를 배포한 계정이 MAIL_FROM 자체이거나, 그 Gmail에 MAIL_FROM이 '다른 주소에서 메일 보내기'로
//    등록돼 있으면 → 발신인이 MAIL_FROM 으로 표시됩니다.
//  - 아니면 배포 계정 주소로 발송되고, 받은 사람이 '답장'을 누르면 MAIL_FROM 으로 갑니다.
function mailMode_() {
  if (!MAIL_FROM) return 'self';
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (me === MAIL_FROM.toLowerCase()) return 'self';
  try {
    if (GmailApp.getAliases().map(a => a.toLowerCase()).indexOf(MAIL_FROM.toLowerCase()) >= 0) return 'alias';
  } catch (e) {}
  return 'replyTo';
}

/* ---------- 신청자 명단 읽기 ---------- */
function readApplicants() { return readSignupTab_(false); }   // 정원 내 신청자 ('신청자' 탭)
function readWaitlist()   { return readSignupTab_(true); }    // 신청대기자 ('대기자' 탭)

function readSignupTab_(wait) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  const prefer = wait ? '대기자' : '신청자';
  const sheets = ss.getSheets().filter(sh => OWN_TABS.indexOf(sh.getName()) < 0)
    .sort((a, b) => (b.getName() === prefer) - (a.getName() === prefer));   // 이름이 맞는 탭을 먼저 확인
  for (const sh of sheets) {
    const range = sh.getDataRange();
    const values = range.getDisplayValues();
    const raw = range.getValues();               // 휴대폰번호는 화면 표시(1.10E+09 등)가 아닌 실제 값으로 읽음
    if (values.length < 1) continue;
    const H = values[0].map(h => String(h).replace(/\s/g, '').toLowerCase());
    const isWait = H.some(h => h.indexOf('대기접수번호') >= 0);
    if (isWait !== wait) continue;
    const col = keys => { for (const k of keys) { const i = H.findIndex(h => h.indexOf(k) >= 0); if (i >= 0) return i; } return -1; };
    const ix = {
      receiptNo: col(wait ? ['대기접수번호'] : ['접수번호']), name: col(['성명', '이름']), sessionText: col(['회차id', '회차']),
      projectNo: col(['과제번호']), org: col(['연구개발기관', '소속기관', '기관']), specOrg: col(['전문기관']),
      phone: col(['휴대폰', '핸드폰', '연락처', '전화']), status: col(['상태', 'status']), seq: col(['발급순번', '대기순번', '순번']),
      email: col(['이메일', 'email']),
    };
    if (ix.receiptNo < 0 || ix.name < 0 || ix.status < 0) continue;
    const g = (r, k) => ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '';
    const phoneOf = i => {
      if (ix.phone < 0) return '';
      const v = raw[i][ix.phone];
      return typeof v === 'number' ? String(Math.round(v)) : String(v || '').trim();
    };
    return values.slice(1).map((r, i) => {
      const a = { receiptNo: g(r, 'receiptNo'), name: g(r, 'name'), sessionText: g(r, 'sessionText'),
        projectNo: g(r, 'projectNo'), org: g(r, 'org'), specOrg: g(r, 'specOrg'), phone: phoneOf(i + 1), email: g(r, 'email'), status: g(r, 'status') };
      if (wait) a.seq = g(r, 'seq');
      return a;
    }).filter(a => a.receiptNo);
  }
  return [];
}

/* ---------- 저장 탭 공통 ---------- */
function sheetOf(key) {
  const T = TABLES[key];
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sh = ss.getSheetByName(T.name);
  if (!sh) {
    sh = ss.insertSheet(T.name);
    sh.getRange(1, 1, 1, T.cols.length + 3).setValues([T.cols.concat(['updatedAt', 'deleted', 'data'])]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideColumns(T.cols.length + 1, 3);       // 내부용 열은 숨김
  }
  return sh;
}

function findRow(sh, id) {
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const f = sh.getRange(2, 1, last - 1, 1).createTextFinder(String(id)).matchEntireCell(true).findNext();
  return f ? f.getRow() : 0;
}

function findRec(key, id) {
  const sh = sheetOf(key);
  const row = findRow(sh, id);
  if (!row) return null;
  const n = TABLES[key].cols.length;
  const v = sh.getRange(row, n + 1, 1, 3).getValues()[0];
  const rec = JSON.parse(v[2] || '{}');
  rec.updatedAt = Number(v[0]);
  rec.deleted = v[1] === 'Y';
  return rec;
}

function upsert(key, rec, deleted) {
  const T = TABLES[key];
  const sh = sheetOf(key);
  const json = JSON.stringify(rec);
  if (json.length > 49000) throw new Error('데이터가 너무 큽니다 (서명/직인 이미지 크기 확인)');
  const row = findRow(sh, T.idOf(rec)) || sh.getLastRow() + 1;
  const now = Date.now();
  const vals = T.row(rec).map(v => v == null ? '' : String(v)).concat([String(now), deleted ? 'Y' : '', json]);
  sh.getRange(row, 1, 1, vals.length).setNumberFormat('@').setValues([vals]);
  return now;
}

function pullTable(key, since) {
  const sh = sheetOf(key);
  const last = sh.getLastRow();
  if (last < 2) return [];
  const n = TABLES[key].cols.length;
  const meta = sh.getRange(2, n + 1, last - 1, 2).getValues();
  const changed = [];
  meta.forEach((v, i) => { if (Number(v[0]) > since) changed.push(i); });
  if (!changed.length) return [];
  const from = changed[0], to = changed[changed.length - 1];          // 바뀐 구간만 읽기
  const data = sh.getRange(2 + from, n + 3, to - from + 1, 1).getValues();
  return changed.map(i => {
    const rec = JSON.parse(data[i - from][0] || '{}');
    rec.updatedAt = Number(meta[i][0]);
    rec.deleted = meta[i][1] === 'Y';
    return rec;
  });
}

function getResetAt() {
  return Number(PropertiesService.getScriptProperties().getProperty('resetAt') || 0);
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* 설치 확인용: 편집기에서 실행하면 명단 인원과 탭 생성을 확인합니다 */
function testSetup() {
  Object.keys(TABLES).forEach(sheetOf);
  Logger.log('오늘 남은 메일 발송 가능 수: ' + MailApp.getRemainingDailyQuota() + '통');   // 메일 권한 승인용
  const mode = mailMode_();
  Logger.log('발신 주소: ' + (mode === 'replyTo'
    ? Session.getEffectiveUser().getEmail() + ' (답장 주소만 ' + MAIL_FROM + ' — 별칭 미등록)'
    : (mode === 'alias' ? MAIL_FROM + ' (Gmail 별칭)' : Session.getEffectiveUser().getEmail())));
  const list = readApplicants();
  Logger.log('명단 ' + list.length + '명, CONFIRMED ' + list.filter(a => a.status.toUpperCase() === 'CONFIRMED').length + '명');
  const w = readWaitlist();
  Logger.log('대기자 ' + w.length + '명, WAITING ' + w.filter(a => a.status.toUpperCase() === 'WAITING').length + '명');
}
