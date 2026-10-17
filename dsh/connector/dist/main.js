// src/index.ts
import { Connector, del, upsert } from "@gety-ai/connector-sdk";

// src/vendor/fzstd.js
var ab = ArrayBuffer;
var u8 = Uint8Array;
var u16 = Uint16Array;
var i16 = Int16Array;
var i32 = Int32Array;
var slc = function(v, s, e) {
  if (u8.prototype.slice) {
    return u8.prototype.slice.call(v, s, e);
  }
  if (s == null || s < 0) {
    s = 0;
  }
  if (e == null || e > v.length) {
    e = v.length;
  }
  var n = new u8(e - s);
  n.set(v.subarray(s, e));
  return n;
};
var fill = function(v, n, s, e) {
  if (u8.prototype.fill) {
    return u8.prototype.fill.call(v, n, s, e);
  }
  if (s == null || s < 0) {
    s = 0;
  }
  if (e == null || e > v.length) {
    e = v.length;
  }
  for (; s < e; ++s) {
    v[s] = n;
  }
  return v;
};
var cpw = function(v, t, s, e) {
  if (u8.prototype.copyWithin) {
    return u8.prototype.copyWithin.call(v, t, s, e);
  }
  if (s == null || s < 0) {
    s = 0;
  }
  if (e == null || e > v.length) {
    e = v.length;
  }
  while (s < e) {
    v[t++] = v[s++];
  }
};
var ec = [
  "invalid zstd data",
  "window size too large (>2046MB)",
  "invalid block type",
  "FSE accuracy too high",
  "match distance too far back",
  "unexpected EOF"
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace) {
    Error.captureStackTrace(e, err);
  }
  if (!nt) {
    throw e;
  }
  return e;
};
var rb = function(d, b, n) {
  var i = 0, o = 0;
  for (; i < n; ++i) {
    o |= d[b++] << (i << 3);
  }
  return o;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var rzfh = function(dat, w) {
  var n3 = dat[0] | dat[1] << 8 | dat[2] << 16;
  if (n3 == 3126568 && dat[3] == 253) {
    var flg = dat[4];
    var ss = flg >> 5 & 1, cc = flg >> 2 & 1, df = flg & 3, fcf = flg >> 6;
    if (flg & 8) {
      err(0);
    }
    var bt = 6 - ss;
    var db = df == 3 ? 4 : df;
    var di = rb(dat, bt, db);
    bt += db;
    var fsb = fcf ? 1 << fcf : ss;
    var fss = rb(dat, bt, fsb) + (fcf == 1 && 256);
    var ws = fss;
    if (!ss) {
      var wb = 1 << 10 + (dat[5] >> 3);
      ws = wb + (wb >> 3) * (dat[5] & 7);
    }
    if (ws > 2145386496) {
      err(1);
    }
    var buf = new u8((w == 1 ? fss || ws : w ? 0 : ws) + 12);
    buf[0] = 1, buf[4] = 4, buf[8] = 8;
    return {
      b: bt + fsb,
      y: 0,
      l: 0,
      d: di,
      w: w && w != 1 ? w : buf.subarray(12),
      e: ws,
      o: new i32(buf.buffer, 0, 3),
      u: fss,
      c: cc,
      m: Math.min(131072, ws)
    };
  } else if ((n3 >> 4 | dat[3] << 20) == 25481893) {
    return b4(dat, 4) + 8;
  }
  err(0);
};
var msb = function(val) {
  var bits = 0;
  for (; 1 << bits <= val; ++bits) ;
  return bits - 1;
};
var rfse = function(dat, bt, mal) {
  var tpos = (bt << 3) + 4;
  var al = (dat[bt] & 15) + 5;
  if (al > mal) {
    err(3);
  }
  var sz = 1 << al;
  var probs = sz, sym = -1, re = -1, i = -1, ht = sz;
  var buf = new ab(512 + (sz << 2));
  var freq = new i16(buf, 0, 256);
  var dstate = new u16(buf, 0, 256);
  var nstate = new u16(buf, 512, sz);
  var bb1 = 512 + (sz << 1);
  var syms = new u8(buf, bb1, sz);
  var nbits = new u8(buf, bb1 + sz);
  while (sym < 255 && probs > 0) {
    var bits = msb(probs + 1);
    var cbt = tpos >> 3;
    var msk = (1 << bits + 1) - 1;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (tpos & 7) & msk;
    var msk1fb = (1 << bits) - 1;
    var msv = msk - probs - 1;
    var sval = val & msk1fb;
    if (sval < msv) {
      tpos += bits, val = sval;
    } else {
      tpos += bits + 1;
      if (val > msk1fb) {
        val -= msv;
      }
    }
    freq[++sym] = --val;
    if (val == -1) {
      probs += val;
      syms[--ht] = sym;
    } else {
      probs -= val;
    }
    if (!val) {
      do {
        var rbt = tpos >> 3;
        re = (dat[rbt] | dat[rbt + 1] << 8) >> (tpos & 7) & 3;
        tpos += 2;
        sym += re;
      } while (re == 3);
    }
  }
  if (sym > 255 || probs) {
    err(0);
  }
  var sympos = 0;
  var sstep = (sz >> 1) + (sz >> 3) + 3;
  var smask = sz - 1;
  for (var s = 0; s <= sym; ++s) {
    var sf = freq[s];
    if (sf < 1) {
      dstate[s] = -sf;
      continue;
    }
    for (i = 0; i < sf; ++i) {
      syms[sympos] = s;
      do {
        sympos = sympos + sstep & smask;
      } while (sympos >= ht);
    }
  }
  if (sympos) {
    err(0);
  }
  for (i = 0; i < sz; ++i) {
    var ns = dstate[syms[i]]++;
    var nb = nbits[i] = al - msb(ns);
    nstate[i] = (ns << nb) - sz;
  }
  return [
    tpos + 7 >> 3,
    {
      b: al,
      s: syms,
      n: nbits,
      t: nstate
    }
  ];
};
var rhu = function(dat, bt) {
  var i = 0, wc = -1;
  var buf = new u8(292), hb = dat[bt];
  var hw = buf.subarray(0, 256);
  var rc = buf.subarray(256, 268);
  var ri = new u16(buf.buffer, 268);
  if (hb < 128) {
    var _a = rfse(dat, bt + 1, 6), ebt = _a[0], fdt = _a[1];
    bt += hb;
    var epos = ebt << 3;
    var lb = dat[bt];
    if (!lb) {
      err(0);
    }
    var st1 = 0, st2 = 0, btr1 = fdt.b, btr2 = btr1;
    var fpos = (++bt << 3) - 8 + msb(lb);
    for (; ; ) {
      fpos -= btr1;
      if (fpos < epos) {
        break;
      }
      var cbt = fpos >> 3;
      st1 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr1) - 1;
      hw[++wc] = fdt.s[st1];
      fpos -= btr2;
      if (fpos < epos) {
        break;
      }
      cbt = fpos >> 3;
      st2 += (dat[cbt] | dat[cbt + 1] << 8) >> (fpos & 7) & (1 << btr2) - 1;
      hw[++wc] = fdt.s[st2];
      btr1 = fdt.n[st1];
      st1 = fdt.t[st1];
      btr2 = fdt.n[st2];
      st2 = fdt.t[st2];
    }
    if (++wc > 255) {
      err(0);
    }
  } else {
    wc = hb - 127;
    for (; i < wc; i += 2) {
      var byte = dat[++bt];
      hw[i] = byte >> 4;
      hw[i + 1] = byte & 15;
    }
    ++bt;
  }
  var wes = 0;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    if (wt > 11) {
      err(0);
    }
    wes += wt && 1 << wt - 1;
  }
  var mb = msb(wes) + 1;
  var ts = 1 << mb;
  var rem = ts - wes;
  if (rem & rem - 1) {
    err(0);
  }
  hw[wc++] = msb(rem) + 1;
  for (i = 0; i < wc; ++i) {
    var wt = hw[i];
    ++rc[hw[i] = wt && mb + 1 - wt];
  }
  var hbuf = new u8(ts << 1);
  var syms = hbuf.subarray(0, ts), nb = hbuf.subarray(ts);
  ri[mb] = 0;
  for (i = mb; i > 0; --i) {
    var pv = ri[i];
    fill(nb, i, pv, ri[i - 1] = pv + rc[i] * (1 << mb - i));
  }
  if (ri[0] != ts) {
    err(0);
  }
  for (i = 0; i < wc; ++i) {
    var bits = hw[i];
    if (bits) {
      var code = ri[bits];
      fill(syms, i, code, ri[bits] = code + (1 << mb - bits));
    }
  }
  return [
    bt,
    {
      n: nb,
      b: mb,
      s: syms
    }
  ];
};
var dllt = rfse(/* @__PURE__ */ new u8([
  81,
  16,
  99,
  140,
  49,
  198,
  24,
  99,
  12,
  33,
  196,
  24,
  99,
  102,
  102,
  134,
  70,
  146,
  4
]), 0, 6)[1];
var dmlt = rfse(/* @__PURE__ */ new u8([
  33,
  20,
  196,
  24,
  99,
  140,
  33,
  132,
  16,
  66,
  8,
  33,
  132,
  16,
  66,
  8,
  33,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  68,
  36,
  9
]), 0, 6)[1];
var doct = rfse(/* @__PURE__ */ new u8([
  32,
  132,
  16,
  66,
  102,
  70,
  68,
  68,
  68,
  68,
  36,
  73,
  2
]), 0, 5)[1];
var b2bl = function(b, s) {
  var len = b.length, bl = new i32(len);
  for (var i = 0; i < len; ++i) {
    bl[i] = s;
    s += 1 << b[i];
  }
  return bl;
};
var llb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  134678020,
  202050057,
  269422093
])).buffer, 0, 36);
var llbl = /* @__PURE__ */ b2bl(llb, 0);
var mlb = /* @__PURE__ */ new u8((/* @__PURE__ */ new i32([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  16843009,
  50528770,
  117769220,
  185207048,
  252579084,
  16
])).buffer, 0, 53);
var mlbl = /* @__PURE__ */ b2bl(mlb, 3);
var dhu = function(dat, out, hu) {
  var len = dat.length, ss = out.length, lb = dat[len - 1], msk = (1 << hu.b) - 1, eb = -hu.b;
  if (!lb) {
    err(0);
  }
  var st = 0, btr = hu.b, pos = (len << 3) - 8 + msb(lb) - btr, i = -1;
  for (; pos > eb && i < ss; ) {
    var cbt = pos >> 3;
    var val = (dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (pos & 7);
    st = (st << btr | val) & msk;
    out[++i] = hu.s[st];
    pos -= btr = hu.n[st];
  }
  if (pos != eb || i + 1 != ss) {
    err(0);
  }
};
var dhu4 = function(dat, out, hu) {
  var bt = 6;
  var ss = out.length, sz1 = ss + 3 >> 2, sz2 = sz1 << 1, sz3 = sz1 + sz2;
  dhu(dat.subarray(bt, bt += dat[0] | dat[1] << 8), out.subarray(0, sz1), hu);
  dhu(dat.subarray(bt, bt += dat[2] | dat[3] << 8), out.subarray(sz1, sz2), hu);
  dhu(dat.subarray(bt, bt += dat[4] | dat[5] << 8), out.subarray(sz2, sz3), hu);
  dhu(dat.subarray(bt), out.subarray(sz3), hu);
};
var rzb = function(dat, st, out) {
  var _a;
  var bt = st.b;
  var b0 = dat[bt], btype = b0 >> 1 & 3;
  st.l = b0 & 1;
  var sz = b0 >> 3 | dat[bt + 1] << 5 | dat[bt + 2] << 13;
  var ebt = (bt += 3) + sz;
  if (btype == 1) {
    if (bt >= dat.length) {
      return;
    }
    st.b = bt + 1;
    if (out) {
      fill(out, dat[bt], st.y, st.y += sz);
      return out;
    }
    return fill(new u8(sz), dat[bt]);
  }
  if (ebt > dat.length) {
    return;
  }
  if (btype == 0) {
    st.b = ebt;
    if (out) {
      out.set(dat.subarray(bt, ebt), st.y);
      st.y += sz;
      return out;
    }
    return slc(dat, bt, ebt);
  }
  if (btype == 2) {
    var b3 = dat[bt], lbt = b3 & 3, sf = b3 >> 2 & 3;
    var lss = b3 >> 4, lcs = 0, s4 = 0;
    if (lbt < 2) {
      if (sf & 1) {
        lss |= dat[++bt] << 4 | (sf & 2 && dat[++bt] << 12);
      } else {
        lss = b3 >> 3;
      }
    } else {
      s4 = sf;
      if (sf < 2) {
        lss |= (dat[++bt] & 63) << 4, lcs = dat[bt] >> 6 | dat[++bt] << 2;
      } else if (sf == 2) {
        lss |= dat[++bt] << 4 | (dat[++bt] & 3) << 12, lcs = dat[bt] >> 2 | dat[++bt] << 6;
      } else {
        lss |= dat[++bt] << 4 | (dat[++bt] & 63) << 12, lcs = dat[bt] >> 6 | dat[++bt] << 2 | dat[++bt] << 10;
      }
    }
    ++bt;
    var buf = out ? out.subarray(st.y, st.y + st.m) : new u8(st.m);
    var spl = buf.length - lss;
    if (lbt == 0) {
      buf.set(dat.subarray(bt, bt += lss), spl);
    } else if (lbt == 1) {
      fill(buf, dat[bt++], spl);
    } else {
      var hu = st.h;
      if (lbt == 2) {
        var hud = rhu(dat, bt);
        lcs += bt - (bt = hud[0]);
        st.h = hu = hud[1];
      } else if (!hu) {
        err(0);
      }
      (s4 ? dhu4 : dhu)(dat.subarray(bt, bt += lcs), buf.subarray(spl), hu);
    }
    var ns = dat[bt++];
    if (ns) {
      if (ns == 255) {
        ns = (dat[bt++] | dat[bt++] << 8) + 32512;
      } else if (ns > 127) {
        ns = ns - 128 << 8 | dat[bt++];
      }
      var scm = dat[bt++];
      if (scm & 3) {
        err(0);
      }
      var dts = [
        dmlt,
        doct,
        dllt
      ];
      for (var i = 2; i > -1; --i) {
        var md = scm >> (i << 1) + 2 & 3;
        if (md == 1) {
          var rbuf = new u8([
            0,
            0,
            dat[bt++]
          ]);
          dts[i] = {
            s: rbuf.subarray(2, 3),
            n: rbuf.subarray(0, 1),
            t: new u16(rbuf.buffer, 0, 1),
            b: 0
          };
        } else if (md == 2) {
          _a = rfse(dat, bt, 9 - (i & 1)), bt = _a[0], dts[i] = _a[1];
        } else if (md == 3) {
          if (!st.t) {
            err(0);
          }
          dts[i] = st.t[i];
        }
      }
      var _b = st.t = dts, mlt = _b[0], oct = _b[1], llt = _b[2];
      var lb = dat[ebt - 1];
      if (!lb) {
        err(0);
      }
      var spos = (ebt << 3) - 8 + msb(lb) - llt.b, cbt = spos >> 3, oubt = 0;
      var lst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << llt.b) - 1;
      cbt = (spos -= oct.b) >> 3;
      var ost = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << oct.b) - 1;
      cbt = (spos -= mlt.b) >> 3;
      var mst = (dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mlt.b) - 1;
      for (++ns; --ns; ) {
        var llc = llt.s[lst];
        var lbtr = llt.n[lst];
        var mlc = mlt.s[mst];
        var mbtr = mlt.n[mst];
        var ofc = oct.s[ost];
        var obtr = oct.n[ost];
        cbt = (spos -= ofc) >> 3;
        var ofp = 1 << ofc;
        var off = ofp + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16 | dat[cbt + 3] << 24) >>> (spos & 7) & ofp - 1);
        cbt = (spos -= mlb[mlc]) >> 3;
        var ml = mlbl[mlc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << mlb[mlc]) - 1);
        cbt = (spos -= llb[llc]) >> 3;
        var ll = llbl[llc] + ((dat[cbt] | dat[cbt + 1] << 8 | dat[cbt + 2] << 16) >> (spos & 7) & (1 << llb[llc]) - 1);
        cbt = (spos -= lbtr) >> 3;
        lst = llt.t[lst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << lbtr) - 1);
        cbt = (spos -= mbtr) >> 3;
        mst = mlt.t[mst] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << mbtr) - 1);
        cbt = (spos -= obtr) >> 3;
        ost = oct.t[ost] + ((dat[cbt] | dat[cbt + 1] << 8) >> (spos & 7) & (1 << obtr) - 1);
        if (off > 3) {
          st.o[2] = st.o[1];
          st.o[1] = st.o[0];
          st.o[0] = off -= 3;
        } else {
          var idx = off - (ll != 0);
          if (idx) {
            off = idx == 3 ? st.o[0] - 1 : st.o[idx];
            if (idx > 1) {
              st.o[2] = st.o[1];
            }
            st.o[1] = st.o[0];
            st.o[0] = off;
          } else {
            off = st.o[0];
          }
        }
        for (var i = 0; i < ll; ++i) {
          buf[oubt + i] = buf[spl + i];
        }
        oubt += ll, spl += ll;
        var stin = oubt - off;
        if (stin < 0) {
          var len = -stin;
          var bs = st.e + stin;
          if (len > ml) {
            len = ml;
          }
          for (var i = 0; i < len; ++i) {
            buf[oubt + i] = st.w[bs + i];
          }
          oubt += len, ml -= len, stin = 0;
        }
        for (var i = 0; i < ml; ++i) {
          buf[oubt + i] = buf[stin + i];
        }
        oubt += ml;
      }
      if (oubt != spl) {
        while (spl < buf.length) {
          buf[oubt++] = buf[spl++];
        }
      } else {
        oubt = buf.length;
      }
      if (out) {
        st.y += oubt;
      } else {
        buf = slc(buf, 0, oubt);
      }
    } else if (out) {
      st.y += lss;
      if (spl) {
        for (var i = 0; i < lss; ++i) {
          buf[i] = buf[spl + i];
        }
      }
    } else if (spl) {
      buf = slc(buf, spl);
    }
    st.b = ebt;
    return buf;
  }
  err(2);
};
var cct = function(bufs, ol) {
  if (bufs.length == 1) {
    return bufs[0];
  }
  var buf = new u8(ol);
  for (var i = 0, b = 0; i < bufs.length; ++i) {
    var chk = bufs[i];
    buf.set(chk, b);
    b += chk.length;
  }
  return buf;
};
var Decompress = /* @__PURE__ */ function() {
  function Decompress2(ondata) {
    this.ondata = ondata;
    this.c = [];
    this.l = 0;
    this.z = 0;
  }
  Decompress2.prototype.push = function(chunk, final) {
    if (typeof this.s == "number") {
      var sub = Math.min(chunk.length, this.s);
      chunk = chunk.subarray(sub);
      this.s -= sub;
    }
    var sl = chunk.length;
    var ncs = sl + this.l;
    if (!this.s) {
      if (final) {
        if (!ncs) {
          this.ondata(new u8(0), true);
          return;
        }
        if (ncs < 5) {
          err(5);
        }
      } else if (ncs < 18) {
        this.c.push(chunk);
        this.l = ncs;
        return;
      }
      if (this.l) {
        this.c.push(chunk);
        chunk = cct(this.c, ncs);
        this.c = [];
        this.l = 0;
      }
      if (typeof (this.s = rzfh(chunk)) == "number") {
        return this.push(chunk, final);
      }
    }
    if (typeof this.s != "number") {
      if (ncs < (this.z || 3)) {
        if (final) {
          err(5);
        }
        this.c.push(chunk);
        this.l = ncs;
        return;
      }
      if (this.l) {
        this.c.push(chunk);
        chunk = cct(this.c, ncs);
        this.c = [];
        this.l = 0;
      }
      if (!this.z && ncs < (this.z = chunk[this.s.b] & 2 ? 4 : 3 + (chunk[this.s.b] >> 3 | chunk[this.s.b + 1] << 5 | chunk[this.s.b + 2] << 13))) {
        if (final) {
          err(5);
        }
        this.c.push(chunk);
        this.l = ncs;
        return;
      } else {
        this.z = 0;
      }
      for (; ; ) {
        var blk = rzb(chunk, this.s);
        if (!blk) {
          if (final) {
            err(5);
          }
          var adc = chunk.subarray(this.s.b);
          this.s.b = 0;
          this.c.push(adc), this.l += adc.length;
          return;
        } else {
          this.ondata(blk, false);
          cpw(this.s.w, 0, blk.length);
          this.s.w.set(blk, this.s.w.length - blk.length);
        }
        if (this.s.l) {
          var rest = chunk.subarray(this.s.b);
          this.s = this.s.c * 4;
          this.push(rest, final);
          return;
        }
      }
    } else if (final) {
      err(5);
    }
  };
  return Decompress2;
}();

// src/dsh_log.ts
var MAX_CONTENT_CHARS = 2e6;
var MAX_TITLE_CHARS = 120;
function decodeSessionBytes(bytes) {
  const parts = [];
  let total = 0;
  const stream = new Decompress((chunk) => {
    parts.push(chunk.slice());
    total += chunk.byteLength;
  });
  try {
    stream.push(bytes, true);
  } catch {
  }
  if (parts.length === 0) return "";
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(merged);
}
function parseEvents(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      const value = JSON.parse(trimmed);
      if (isRecord(value) && typeof value.type === "string") {
        events.push(value);
      }
    } catch {
    }
  }
  return events;
}
function isIndexableSession(session) {
  return session !== null && session.messageCount > 0;
}
function renderSession(events, filePath, options) {
  const header = events.find((event) => event.type === "session");
  if (header === void 0) return null;
  const id = typeof header.id === "string" && header.id !== "" ? header.id : sessionIdFromPath(filePath);
  const cwd = typeof header.cwd === "string" ? header.cwd : "";
  let title = "";
  let titleFromEvent = false;
  const rounds = [];
  let firstPrompt = "";
  let messageCount = 0;
  let toolCallCount = 0;
  let model = "";
  const createdMs = typeof header.createdAt === "number" ? header.createdAt : 0;
  let updatedMs = createdMs;
  const toolLines = [];
  for (const event of events) {
    if (typeof event.time === "number") {
      updatedMs = Math.max(updatedMs, event.time);
    }
    const eventData = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "session/title": {
        const next = typeof eventData.title === "string" ? eventData.title.trim() : "";
        if (next !== "") {
          title = next;
          titleFromEvent = true;
        }
        break;
      }
      case "model/selection": {
        const provider = typeof eventData.provider === "string" ? eventData.provider : "";
        const name = typeof eventData.model === "string" ? eventData.model : "";
        if (name !== "") model = provider === "" ? name : `${provider}/${name}`;
        break;
      }
      case "request/header": {
        if (model !== "") break;
        const requestHeader = isRecord(eventData.header) ? eventData.header : {};
        const config = isRecord(requestHeader.config) ? requestHeader.config : {};
        const provider = typeof config.provider === "string" ? config.provider : "";
        const name = typeof config.model === "string" ? config.model : "";
        if (name !== "") model = provider === "" ? name : `${provider}/${name}`;
        break;
      }
      case "user/message": {
        const source = isRecord(eventData.source) ? eventData.source : {};
        if (source.kind !== "user" && source.kind !== "command") break;
        const text = blocksToText(eventData.content);
        if (text === "") break;
        if (firstPrompt === "") firstPrompt = text;
        messageCount += 1;
        rounds.push(`### User

${text}`);
        break;
      }
      case "assistant/message": {
        const message = isRecord(eventData.message) ? eventData.message : {};
        const text = blocksToText(message.content);
        if (text === "") break;
        messageCount += 1;
        rounds.push(`### DSH

${text}`);
        break;
      }
      case "tool/call": {
        toolCallCount += 1;
        if (options.includeToolCalls) {
          toolLines.push(toolSummary(eventData));
        }
        break;
      }
      default:
        break;
    }
  }
  if (messageCount === 0) return null;
  if (!titleFromEvent || title === "") {
    title = titleFromPrompt(firstPrompt) ?? `Session ${shortId(id)}`;
  }
  const workspacePath = options.workspace?.path ?? cwd;
  const workspaceTitle = options.workspace?.title ?? baseName(workspacePath) ?? "Unknown workspace";
  const createdAt = toIso(createdMs);
  const updatedAt = toIso(updatedMs);
  const lines = [
    `# ${title}`,
    "",
    `> Workspace: \`${workspacePath}\` \xB7 Model: \`${model || "unknown"}\` \xB7 Created: ${createdAt} \xB7 Messages: ${messageCount}`,
    ""
  ];
  if (toolCallCount > 0 && toolLines.length > 0) {
    lines.push("### Tool calls", "", ...toolLines.slice(0, 200).map((line) => `- ${line}`), "");
  }
  for (const [index, round] of rounds.entries()) {
    if (index > 0) lines.push("---", "");
    lines.push(round, "");
  }
  let markdown = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
  if (markdown.length > MAX_CONTENT_CHARS) {
    markdown = markdown.slice(0, MAX_CONTENT_CHARS) + "\n\n_[Session content truncated by the DeepSeek Harness connector.]_\n";
  }
  return {
    id,
    filePath,
    workspaceId: options.workspace?.id ?? null,
    workspaceTitle,
    workspacePath,
    title,
    url: fileUrl(filePath),
    createdAt,
    updatedAt,
    model,
    messageCount,
    delegationDepth: typeof header.delegationDepth === "number" ? header.delegationDepth : 0,
    toolCallCount,
    markdown,
    contentBytes: markdown.length
  };
}
function blocksToText(content) {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const pieces = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text !== "") pieces.push(text);
    }
  }
  return pieces.join("\n\n").trim();
}
function titleFromPrompt(prompt) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized === "") return null;
  return normalized.length > MAX_TITLE_CHARS ? `${normalized.slice(0, MAX_TITLE_CHARS - 1)}\u2026` : normalized;
}
function sessionIdFromPath(filePath) {
  const segments = filePath.split(/[\\/]/).filter(Boolean);
  const dir = segments.length >= 2 ? segments[segments.length - 2] ?? "" : "";
  return dir.startsWith("session-") ? dir : baseName(filePath) ?? filePath;
}
function toolSummary(data) {
  const name = typeof data.name === "string" ? data.name : "tool";
  const args = typeof data.arguments === "string" ? data.arguments : "";
  let detail = "";
  if (args !== "") {
    try {
      const parsed = JSON.parse(args);
      if (isRecord(parsed)) {
        const description = typeof parsed.description === "string" ? parsed.description : "";
        const command = typeof parsed.command === "string" ? parsed.command : "";
        detail = description || command;
      }
    } catch {
      detail = args;
    }
  }
  detail = detail.replace(/\s+/g, " ").trim();
  if (detail.length > 180) detail = `${detail.slice(0, 179)}\u2026`;
  return `\`${name}\`${detail === "" ? "" : ` \u2014 ${detail}`}`;
}
function fileUrl(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash)}`;
}
function baseName(path) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? null : segments[segments.length - 1] ?? null;
}
function shortId(id) {
  const match = /([0-9a-f]{8})[0-9a-f-]*$/i.exec(id);
  return match?.[1] ?? id.slice(0, 8);
}
function toIso(ms) {
  const value = ms > 0 ? ms : Date.now();
  return new Date(value).toISOString();
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/dsh_home.ts
function resolveDshHome() {
  const explicit = Deno.env.get("DSH_HOME");
  if (explicit !== void 0 && explicit.trim() !== "") return explicit.trim();
  const userProfile = Deno.env.get("USERPROFILE");
  if (userProfile !== void 0 && userProfile.trim() !== "") {
    return `${userProfile.trim()}\\.dsh`;
  }
  const home = Deno.env.get("HOME");
  if (home !== void 0 && home.trim() !== "") return `${home.trim()}/.dsh`;
  return ".dsh";
}
async function readWorkspaces(dshHome) {
  const path = `${dshHome}/storages/workspace.json`;
  let raw;
  try {
    raw = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  if (!isRecord2(raw) || !isRecord2(raw.tables) || !isRecord2(raw.tables.workspaces)) throw new Error("Invalid DSH workspace registry");
  const workspaces = [];
  for (const [id, value] of Object.entries(raw.tables.workspaces)) {
    if (!isRecord2(value) || typeof value.path !== "string") continue;
    const sessionIds = Array.isArray(value.sessionIds) ? value.sessionIds.filter((entry) => typeof entry === "string") : [];
    workspaces.push({
      id,
      title: typeof value.title === "string" && value.title !== "" ? value.title : baseName2(value.path) ?? id,
      path: value.path,
      sessionIds
    });
  }
  workspaces.sort((left, right) => left.title.localeCompare(right.title));
  return workspaces;
}
async function readShareConfig(dshHome) {
  const path = `${dshHome}/gety-connector.json`;
  try {
    const raw = JSON.parse(await Deno.readTextFile(path));
    if (!isRecord2(raw) || !(raw.workspaces === null || Array.isArray(raw.workspaces) && raw.workspaces.every((entry) => typeof entry === "string"))) throw new Error("Invalid DSH workspace sharing configuration");
    const workspaces = raw.workspaces;
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      workspaces,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : void 0
    };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return defaultShareConfig();
    throw error;
  }
}
function defaultShareConfig() {
  return {
    version: 1,
    workspaces: null
  };
}
function workspaceDirName(workspacePath) {
  const encoded = workspacePath.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `--${encoded}--`;
}
function workspaceForDir(workspaces, dirName) {
  const target = dirName.toLowerCase();
  for (const workspace of workspaces) {
    if (workspaceDirName(workspace.path).toLowerCase() === target) {
      return workspace;
    }
  }
  return null;
}
function workspaceForPath(workspaces, path) {
  const normalize = (value) => value.replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
  const target = normalize(path);
  for (const workspace of workspaces) {
    if (normalize(workspace.path) === target) return workspace;
  }
  return null;
}
function isWorkspaceSelected(config, workspace, dirName) {
  if (config.workspaces === null) return true;
  const selected = new Set(config.workspaces.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
  if (selected.has("*")) return true;
  if (workspace !== null) {
    if (selected.has(workspace.id.toLowerCase())) return true;
    if (selected.has(workspace.path.replace(/\//g, "\\").toLowerCase())) {
      return true;
    }
    if (selected.has(workspaceDirName(workspace.path).toLowerCase())) {
      return true;
    }
  }
  return selected.has(dirName.toLowerCase());
}
async function listSessionFiles(dshHome) {
  const root = `${dshHome}/sessions`;
  const files = [];
  const workspaceDirs = [];
  for await (const entry of Deno.readDir(root)) {
    if (entry.isDirectory) workspaceDirs.push(entry);
  }
  for (const workspaceDir of workspaceDirs) {
    const workspacePath = `${root}/${workspaceDir.name}`;
    let sessionDirs;
    try {
      sessionDirs = [];
      for await (const entry of Deno.readDir(workspacePath)) {
        if (entry.isDirectory) sessionDirs.push(entry);
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    for (const sessionDir of sessionDirs) {
      const dirPath = `${workspacePath}/${sessionDir.name}`;
      let entries;
      try {
        entries = [];
        for await (const entry of Deno.readDir(dirPath)) entries.push(entry);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile) continue;
        if (!/^session\.v\d+\.jsonl(?:\.zstd)?$/i.test(entry.name)) continue;
        const path = `${dirPath}/${entry.name}`;
        let stat;
        try {
          stat = await Deno.stat(path);
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        if (!stat.isFile) continue;
        files.push({
          path,
          stateKey: `${workspaceDir.name}/${sessionDir.name}/${entry.name}`,
          workspaceDir: workspaceDir.name,
          sessionId: sessionDir.name,
          mtimeMs: stat.mtime?.getTime() ?? 0,
          size: stat.size
        });
      }
    }
  }
  files.sort((left, right) => left.stateKey.localeCompare(right.stateKey));
  return files;
}
function baseName2(path) {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments.length === 0 ? null : segments[segments.length - 1] ?? null;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/index.ts
var STATE_SCHEMA_VERSION = 1;
var DshConnector = class extends Connector {
  async *poll() {
    const includeToolCalls = this.config.include_tool_calls ?? false;
    const includeSubagents = this.config.include_subagents ?? true;
    const state = initialState(this.lastState, includeToolCalls, includeSubagents);
    const previousFiles = state.files ?? {};
    const previousIndexed = new Set(state.indexed_sessions ?? indexedSessionIds(previousFiles));
    const dshHome = resolveDshHome();
    const shareConfig = await readShareConfig(dshHome);
    const workspaces = await readWorkspaces(dshHome);
    const files = await listSessionFiles(dshHome);
    const currentFiles = {};
    const currentIndexed = /* @__PURE__ */ new Set();
    for (const file of files) {
      this.signal.throwIfAborted();
      const previous = previousFiles[file.stateKey];
      const workspace = workspaceForDir(workspaces, file.workspaceDir) ?? workspaceForSessionId(workspaces, previous?.session_id ?? file.sessionId);
      const allowed = isWorkspaceSelected(shareConfig, workspace, file.workspaceDir);
      if (previous !== void 0 && !fileNeedsParse(file, previous) && allowed) {
        currentFiles[file.stateKey] = previous;
        if (previous.indexed && previous.session_id !== void 0) {
          currentIndexed.add(previous.session_id);
        }
        continue;
      }
      if (!allowed) {
        currentFiles[file.stateKey] = {
          ...previous ?? {},
          workspace_id: workspace?.id ?? previous?.workspace_id ?? null,
          mtime_ms: file.mtimeMs,
          size: file.size,
          indexed: false
        };
        continue;
      }
      const session = await this.parseFile(file, workspaces, workspace, includeToolCalls);
      if (session === null || !isIndexableSession(session) || !includeSubagents && session.delegationDepth > 0) {
        currentFiles[file.stateKey] = {
          workspace_id: workspace?.id ?? null,
          mtime_ms: file.mtimeMs,
          size: file.size,
          indexed: false
        };
        continue;
      }
      currentFiles[file.stateKey] = {
        session_id: session.id,
        workspace_id: session.workspaceId,
        mtime_ms: file.mtimeMs,
        size: file.size,
        indexed: true
      };
      currentIndexed.add(session.id);
      yield {
        updates: [
          buildSessionUpdate(session, file.size)
        ]
      };
    }
    for (const sessionId of previousIndexed) {
      if (!currentIndexed.has(sessionId)) {
        yield {
          updates: [
            del(sessionId)
          ]
        };
      }
    }
    yield {
      updates: [],
      state: nextState(currentFiles, includeToolCalls, includeSubagents)
    };
  }
  async parseFile(file, workspaces, workspace, includeToolCalls) {
    const text = decodeSessionBytes(await Deno.readFile(file.path));
    if (text.trim() === "") return null;
    const events = parseEvents(text);
    const header = events.find((event) => event.type === "session");
    const cwd = header?.cwd ?? "";
    const resolved = workspace ?? (cwd === "" ? null : workspaceForPath(workspaces, cwd));
    return renderSession(events, file.path, {
      includeToolCalls,
      workspace: resolved
    });
  }
};
function initialState(state, includeToolCalls, includeSubagents) {
  if (state?.schema_version !== STATE_SCHEMA_VERSION || state.include_tool_calls !== includeToolCalls || state.include_subagents !== includeSubagents) {
    return {
      schema_version: STATE_SCHEMA_VERSION,
      include_tool_calls: includeToolCalls,
      include_subagents: includeSubagents,
      files: {},
      indexed_sessions: state?.indexed_sessions ?? indexedSessionIds(state?.files ?? {})
    };
  }
  return state;
}
function fileNeedsParse(file, previous) {
  return !previous.indexed || previous.mtime_ms !== file.mtimeMs || previous.size !== file.size;
}
function buildSessionUpdate(session, fileSize) {
  return upsert({
    id: session.id,
    title: session.title,
    content: session.markdown,
    content_format: "markdown",
    doc_type: "dsh:session",
    doc_updated_at: session.updatedAt,
    original_file_size: fileSize,
    metadata: {
      url: session.url,
      workspace: session.workspacePath,
      workspace_title: session.workspaceTitle,
      workspace_id: session.workspaceId ?? "",
      model: session.model,
      created_at: session.createdAt,
      messages: session.messageCount,
      tool_calls: session.toolCallCount
    }
  });
}
function workspaceForSessionId(workspaces, sessionId) {
  if (sessionId === void 0) return null;
  for (const workspace of workspaces) {
    if (workspace.sessionIds.includes(sessionId)) return workspace;
  }
  return null;
}
function nextState(files, includeToolCalls, includeSubagents) {
  const sortedFiles = Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
  return {
    schema_version: STATE_SCHEMA_VERSION,
    include_tool_calls: includeToolCalls,
    include_subagents: includeSubagents,
    files: sortedFiles,
    indexed_sessions: indexedSessionIds(sortedFiles)
  };
}
function indexedSessionIds(files) {
  const ids = [];
  for (const file of Object.values(files)) {
    if (file.indexed && file.session_id !== void 0) {
      ids.push(file.session_id);
    }
  }
  return [
    ...new Set(ids)
  ].sort();
}
export {
  buildSessionUpdate,
  DshConnector as default,
  fileNeedsParse,
  initialState
};
