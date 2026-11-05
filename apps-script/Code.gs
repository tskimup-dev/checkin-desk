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

// 각 탭: 사람이 읽는 열들 + [updatedAt, deleted, data(JSON 원본)]
const TABLES = {
  attend: {
    name: '참석기록',
    cols: ['id', '회차', '접수번호', '성명', '기관', '과제번호', '휴대폰번호', '참석시각', '데스크', '구분'],
    idOf: r => r.id,
    row: r => [r.id, r.session, r.receiptNo, r.name, r.org, r.projectNo, r.phone, r.checkinAt, r.desk,
               r.source === 'walkin' ? '현장 신청' : r.source === 'other' ? '타 회차 승인' : '사전 신청'],
  },
  approvals: {
    name: '승인',
    cols: ['id', '회차', '접수번호', '성명', '기관', '신청회차', '현장신청', '상태', '요청시각', '처리시각', '데스크'],
    idOf: r => r.id,
    row: r => [r.id, r.session, r.receiptNo, r.name, r.org, r.appliedSession, r.walkin ? 'Y' : '',
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
  if (p.full === '1') o.applicants = readApplicants();
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
      default:
        return out({ ok: false, error: 'action' });
    }
  } catch (err) {
    return out({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- 신청자 명단 읽기 ---------- */
function readApplicants() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  for (const sh of ss.getSheets()) {
    if (OWN_TABS.indexOf(sh.getName()) >= 0) continue;
    const values = sh.getDataRange().getDisplayValues();
    if (values.length < 1) continue;
    const H = values[0].map(h => String(h).replace(/\s/g, '').toLowerCase());
    const col = keys => { for (const k of keys) { const i = H.findIndex(h => h.indexOf(k) >= 0); if (i >= 0) return i; } return -1; };
    const ix = {
      receiptNo: col(['접수번호']), name: col(['성명', '이름']), sessionText: col(['회차id', '회차']),
      projectNo: col(['과제번호']), org: col(['연구개발기관', '소속기관', '기관']),
      phone: col(['휴대폰', '핸드폰', '연락처', '전화']), status: col(['상태', 'status']),
    };
    if (ix.receiptNo < 0 || ix.name < 0 || ix.status < 0) continue;
    const g = (r, k) => ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '';
    return values.slice(1).map(r => ({
      receiptNo: g(r, 'receiptNo'), name: g(r, 'name'), sessionText: g(r, 'sessionText'),
      projectNo: g(r, 'projectNo'), org: g(r, 'org'), phone: g(r, 'phone'), status: g(r, 'status'),
    })).filter(a => a.receiptNo);
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
  const list = readApplicants();
  Logger.log('명단 ' + list.length + '명, CONFIRMED ' + list.filter(a => a.status.toUpperCase() === 'CONFIRMED').length + '명');
}
