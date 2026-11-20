'use strict';

/**
 * 展品点交台账（展馆 × 运输 双侧采集）。
 *
 * 设计要点：
 * - 采集（ingest）只做结构校验与按 slipId 去重；语义校验（compute）每次都
 *   对全部已收单据按“事件发生时间”重放折叠，绝不只取最后一条。
 * - 支持补交早到记录：事件按 (at, seq) 排序，晚到的单据会插回正确位置，
 *   状态随之重算，并打上 late 标记。
 * - 箱子换编号：renumberTo 建立 新编号 -> 原箱 的别名，位置报告按任意历史
 *   编号都能找到原箱，并保留完整交接链。
 * - 物件级连续追踪 + 箱标签关联并行：部分转交（只转交箱内部分展品）时，
 *   以物件为单位在箱之间移动，箱只作为容器快照。
 */

const SIDES = new Set(['hall', 'transport']);
const KINDS = new Set(['pack', 'transfer', 'unpack']);

const KIND_LABEL = { pack: '装箱', transfer: '转运', unpack: '开箱' };

function describeLocation(loc) {
  if (!loc) return '未装箱';
  if (loc.type === 'box') return `箱 ${loc.box}`;
  return `${loc.party} 处`;
}

class Ledger {
  constructor() {
    this.objects = new Map(); // id -> { id, name }
    this.events = [];         // 已受理单据，按 (at, seq) 排序
    this.seq = 0;             // 受理顺序号
    this.slipIds = new Set();
    this.duplicates = [];     // 重复交单记录
    this.rejected = [];       // 结构拒收记录
    this.problems = [];       // 最近一次重放的语义问题
    this.state = null;        // 最近一次重放得到的快照（内部结构）
    this.compute();
  }

  registerObjects(list) {
    for (const o of list) this.objects.set(o.id, { id: o.id, name: o.name });
    this.compute();
  }

  /** 结构校验；返回 null 表示通过，否则返回拒收原因码。 */
  validateShape(slip) {
    if (!slip || typeof slip !== 'object' || Array.isArray(slip)) return 'slip-not-object';
    if (typeof slip.slipId !== 'string' || slip.slipId.trim() === '') return 'missing-slipId';
    if (!SIDES.has(slip.side)) return 'bad-side';
    if (!KINDS.has(slip.kind)) return 'bad-kind';
    if (!Number.isFinite(slip.at)) return 'bad-at';
    if (typeof slip.boxLabel !== 'string' || slip.boxLabel.trim() === '') return 'missing-boxLabel';
    if (slip.items !== undefined) {
      if (!Array.isArray(slip.items) || slip.items.some((x) => typeof x !== 'string')) return 'bad-items';
      const unknown = slip.items.filter((id) => !this.objects.has(id));
      if (unknown.length > 0) return 'unknown-object';
    }
    if (slip.renumberTo !== undefined && typeof slip.renumberTo !== 'string') return 'bad-renumberTo';
    if (slip.targetBox !== undefined && typeof slip.targetBox !== 'string') return 'bad-targetBox';
    return null;
  }

  /**
   * 受理一张单据。
   * 返回 { status: 'accepted' | 'duplicate' | 'rejected', ... }。
   */
  ingest(slip) {
    if (slip && typeof slip === 'object' && typeof slip.slipId === 'string' && this.slipIds.has(slip.slipId)) {
      const dup = { slipId: slip.slipId, side: slip.side, kind: slip.kind };
      this.duplicates.push(dup);
      return { status: 'duplicate', slipId: slip.slipId };
    }
    const reason = this.validateShape(slip);
    if (reason) {
      this.rejected.push({ slip, reason });
      return { status: 'rejected', reason, slipId: slip && slip.slipId };
    }
    // 早于已受理事件的最大发生时间 => 补交的早到记录
    let maxAt = -Infinity;
    for (const e of this.events) if (e.at > maxAt) maxAt = e.at;
    const late = this.events.length > 0 && slip.at < maxAt;
    const event = {
      slipId: slip.slipId,
      side: slip.side,
      kind: slip.kind,
      boxLabel: slip.boxLabel,
      items: slip.items ? [...slip.items] : undefined,
      targetBox: slip.targetBox,
      renumberTo: slip.renumberTo,
      from: slip.from,
      to: slip.to,
      note: slip.note,
      at: slip.at,
      late,
      seq: this.seq++,
    };
    this.slipIds.add(event.slipId);
    this.events.push(event);
    this.events.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
    this.compute();
    return { status: 'accepted', slipId: event.slipId, late };
  }

  /** 批量采集一侧（或两侧合并）的交单。 */
  ingestBatch(slips, source) {
    const summary = { source: source || 'batch', accepted: 0, duplicates: 0, rejected: 0, details: [] };
    for (const slip of slips) {
      const r = this.ingest(slip);
      summary.details.push(r);
      if (r.status === 'accepted') summary.accepted += 1;
      else if (r.status === 'duplicate') summary.duplicates += 1;
      else summary.rejected += 1;
    }
    return summary;
  }

  /** 按发生时间重放全部单据，折叠出当前状态与校验问题。 */
  compute() {
    const boxes = new Map();    // 规范箱号 -> 箱
    const alias = new Map();    // 历史/新编号 -> 规范箱号
    const objects = new Map();  // id -> { id, name, location, chain }
    for (const [id, o] of this.objects) {
      objects.set(id, { id, name: o.name, location: null, chain: [] });
    }
    const renumbers = [];
    const problems = [];

    const resolve = (label) => {
      let cur = label;
      const seen = new Set([cur]);
      while (alias.has(cur) && !seen.has(alias.get(cur))) {
        cur = alias.get(cur);
        seen.add(cur);
      }
      return cur;
    };
    const ensureBox = (canonical, holder) => {
      if (!boxes.has(canonical)) {
        boxes.set(canonical, {
          id: canonical, labels: [canonical], status: 'sealed',
          holder: holder || null, contents: new Set(), events: [],
        });
      }
      return boxes.get(canonical);
    };
    const problem = (code, message, ev) => {
      problems.push({ code, message, slipId: ev.slipId, at: ev.at });
    };
    const chainEntry = (ev, extra) => ({
      at: ev.at, kind: ev.kind, kindLabel: KIND_LABEL[ev.kind],
      box: extra.box, label: ev.boxLabel, from: ev.from, to: ev.to,
      slipId: ev.slipId, side: ev.side, late: !!ev.late,
      renumberTo: ev.renumberTo, targetBox: ev.targetBox,
    });

    for (const ev of this.events) {
      if (ev.kind === 'pack') {
        const canonical = resolve(ev.boxLabel);
        const box = ensureBox(canonical, ev.from);
        if (box.events.length > 0 && box.contents.size > 0) {
          problem('box-not-empty', `装箱单 ${ev.slipId}：箱 ${ev.boxLabel} 内尚有 ${box.contents.size} 件未清`, ev);
        }
        box.holder = ev.from || box.holder;
        box.status = 'sealed';
        for (const item of ev.items || []) {
          const obj = objects.get(item);
          if (obj.location) {
            problem('object-already-located',
              `装箱单 ${ev.slipId}：物件 ${item} 已在${describeLocation(obj.location)}，不能重复装箱`, ev);
          } else {
            obj.location = { type: 'box', box: canonical };
            box.contents.add(item);
          }
          obj.chain.push(chainEntry(ev, { box: canonical }));
        }
        box.events.push(ev);
      } else if (ev.kind === 'transfer') {
        const canonical = resolve(ev.boxLabel);
        const box = boxes.get(canonical);
        if (!box) {
          problem('unknown-box', `转运单 ${ev.slipId}：找不到箱 ${ev.boxLabel}`, ev);
          continue;
        }
        if (ev.from && box.holder && ev.from !== box.holder) {
          problem('holder-mismatch',
            `转运单 ${ev.slipId}：交方「${ev.from}」与当前持有方「${box.holder}」不一致，交接链存在断点`, ev);
        }
        if (ev.renumberTo) {
          alias.set(ev.renumberTo, canonical);
          if (!box.labels.includes(ev.renumberTo)) box.labels.push(ev.renumberTo);
          renumbers.push({ from: ev.boxLabel, to: ev.renumberTo, at: ev.at, slipId: ev.slipId });
        }
        if (ev.items && ev.items.length > 0) {
          // 部分（或指定清单）转交：按物件移动；源箱持有方不变，目标箱归接收方
          const targetCanonical = ev.targetBox ? resolve(ev.targetBox) : canonical;
          const target = ensureBox(targetCanonical, ev.to);
          if (targetCanonical !== canonical) {
            target.holder = ev.to || target.holder;
            target.status = 'sealed';
          }
          for (const item of ev.items) {
            const obj = objects.get(item);
            if (!box.contents.has(item)) {
              problem('item-not-in-box',
                `转运单 ${ev.slipId}：物件 ${item} 不在箱 ${ev.boxLabel} 中（当前在${describeLocation(obj.location)}）`, ev);
              continue;
            }
            box.contents.delete(item);
            target.contents.add(item);
            obj.location = { type: 'box', box: targetCanonical };
            obj.chain.push(chainEntry(ev, { box: targetCanonical }));
          }
          if (targetCanonical !== canonical) target.events.push(ev);
        } else {
          // 整箱转运：持有方变更（可伴随换编号）
          box.holder = ev.to || box.holder;
          for (const item of box.contents) {
            objects.get(item).chain.push(chainEntry(ev, { box: canonical }));
          }
        }
        box.events.push(ev);
      } else if (ev.kind === 'unpack') {
        const canonical = resolve(ev.boxLabel);
        const box = boxes.get(canonical);
        if (!box) {
          problem('unknown-box', `开箱单 ${ev.slipId}：找不到箱 ${ev.boxLabel}`, ev);
          continue;
        }
        if (box.status === 'opened') {
          problem('box-already-opened', `开箱单 ${ev.slipId}：箱 ${ev.boxLabel} 已开过箱`, ev);
        }
        if (ev.from && box.holder && ev.from !== box.holder) {
          problem('holder-mismatch',
            `开箱单 ${ev.slipId}：交方「${ev.from}」与当前持有方「${box.holder}」不一致，交接链存在断点`, ev);
        }
        const items = (ev.items && ev.items.length > 0) ? ev.items : [...box.contents];
        for (const item of items) {
          const obj = objects.get(item);
          if (!box.contents.has(item)) {
            problem('item-not-in-box',
              `开箱单 ${ev.slipId}：物件 ${item} 不在箱 ${ev.boxLabel} 中（当前在${describeLocation(obj.location)}）`, ev);
            continue;
          }
          box.contents.delete(item);
          obj.location = { type: 'custody', party: ev.to || ev.from || '签收方' };
          obj.chain.push(chainEntry(ev, { box: canonical }));
        }
        box.status = 'opened';
        box.holder = ev.to || box.holder;
        box.events.push(ev);
      }
    }

    this.problems = problems;
    this.state = { boxes, objects, renumbers, alias, resolve, problems };
  }

  /** 物件当前状态文字。 */
  objectStatus(obj) {
    if (!obj.location) return '未装箱';
    if (obj.location.type === 'box') {
      const box = this.state.boxes.get(obj.location.box);
      const holder = box && box.holder ? `，持有：${box.holder}` : '';
      return `在箱 ${obj.location.box}${holder}`;
    }
    return `已签收·${obj.location.party}`;
  }

  /** 物件交接链（含换编号与补录标记）。 */
  objectChain(id) {
    const obj = this.state.objects.get(id);
    if (!obj) return null;
    return {
      id: obj.id,
      name: obj.name,
      status: this.objectStatus(obj),
      hops: obj.chain.length,
      chain: obj.chain,
    };
  }

  /**
   * 箱位置报告：任意历史编号均可查询；换编号时能回到原箱并保留交接链。
   */
  boxReport(label) {
    const st = this.state;
    const canonical = st.resolve(label);
    const box = st.boxes.get(canonical);
    if (!box) return { query: label, found: false };
    const knownAs = label !== canonical ? `${label}（原箱 ${canonical}）` : canonical;
    return {
      query: label,
      found: true,
      canonical,
      knownAs,
      labels: [...box.labels],
      status: box.status,
      holder: box.holder,
      contents: [...box.contents],
      renumbers: st.renumbers.filter((r) => box.labels.includes(r.from) || box.labels.includes(r.to)),
      events: box.events.map((e) => ({
        slipId: e.slipId, kind: e.kind, kindLabel: KIND_LABEL[e.kind], side: e.side,
        at: e.at, from: e.from, to: e.to, boxLabel: e.boxLabel, late: !!e.late,
      })),
    };
  }

  /** 对外快照（JSON 可序列化）。 */
  snapshot() {
    const st = this.state;
    return {
      stats: {
        objects: st.objects.size,
        boxes: st.boxes.size,
        events: this.events.length,
        duplicates: this.duplicates.length,
        rejected: this.rejected.length,
        problems: st.problems.length,
      },
      objects: [...st.objects.values()].map((o) => ({
        id: o.id, name: o.name, location: o.location, status: this.objectStatus(o), hops: o.chain.length,
      })),
      boxes: [...st.boxes.values()].map((b) => ({
        id: b.id, labels: [...b.labels], status: b.status, holder: b.holder, contents: [...b.contents],
      })),
      renumbers: st.renumbers,
      problems: st.problems,
      events: this.events.map((e) => ({
        slipId: e.slipId, kind: e.kind, kindLabel: KIND_LABEL[e.kind], side: e.side,
        boxLabel: e.boxLabel, items: e.items, from: e.from, to: e.to, at: e.at, late: e.late,
        renumberTo: e.renumberTo, targetBox: e.targetBox,
      })),
      duplicates: this.duplicates,
      rejected: this.rejected.map((r) => ({ slipId: r.slip && r.slip.slipId, reason: r.reason })),
    };
  }
}

module.exports = { Ledger, KIND_LABEL };
