(() => {
  BBPlugin.register("cape_uv", {
    title: "Cape UV",
    author: "Custom Plugin",
    description: "Mapea cada face a una celda cuadrada en grilla.",
    version: "5.0.0",
    variant: "both",
    tags: ["UV", "Texturing"],

    onload() {
      const self = this;
      self.settings = { padX: 1, padY: 1, keepLength: false };

      self.action = new Action("cape_uv_action", {
        name: "Cape UV",
        icon: "view_in_ar",
        click() {
          const s = self.settings;
          new Dialog({
            id: "cape_uv_dialog",
            title: "Cape UV",
            width: 360,
            form: {
              padX:       { label: "Padding X (px)",   type: "number",   value: s.padX,       step: 1, min: 0 },
              padY:       { label: "Padding Y (px)",   type: "number",   value: s.padY,       step: 1, min: 0 },
              keepLength: { label: "Keep Face Length", type: "checkbox", value: s.keepLength },
            },
            buttons: ["Aplicar", "Cancelar"],
            onConfirm(form) {
              s.padX       = Math.max(0, parseInt(form.padX) || 0);
              s.padY       = Math.max(0, parseInt(form.padY) || 0);
              s.keepLength = !!form.keepLength;
              runCapeUV(s);
            },
          }).show();
        },
      });

      MenuBar.addAction(self.action, "uv");
      MenuBar.addAction(self.action, "tools");
    },

    onunload() { this.action && this.action.delete(); },
  });

  // ════════════════════════════════════════════════════════════════════════
  function runCapeUV({ padX, padY, keepLength }) {
    const targetMeshes = Mesh.selected.length ? Mesh.selected : Mesh.all;
    const targetCubes  = Cube.selected.length ? Cube.selected : Cube.all;

    if (!targetMeshes.length && !targetCubes.length) {
      Blockbench.showQuickMessage("No hay elementos para procesar.", 2000);
      return;
    }

    // Tamaño de textura como output
    const tex  = Texture.all[0];
    const outW = (tex && tex.width)  || (Project && Project.texture_width)  || 128;
    const outH = (tex && tex.height) || (Project && Project.texture_height) || 128;

    const meshFaces = [];
    targetMeshes.forEach(mesh =>
      Object.keys(mesh.faces).forEach(fk => meshFaces.push({ mesh, fk }))
    );
    const cubeFaceList = [];
    targetCubes.forEach(cube => {
      ["up","down","north","south","west","east"].forEach(n => {
        if (cube.faces[n]) cubeFaceList.push({ cube, n });
      });
    });

    const total = meshFaces.length + cubeFaceList.length;
    if (!total) return;

    // ── Tamaño base de cada celda ──────────────────────────────────────────
    let faceSizes;
    if (keepLength) {
      // Proporcional al span real de cada face
      const spans   = meshFaces.map(({ mesh, fk }) => getFaceSpan(mesh, fk));
      const maxSpan = spans.reduce((m, s) => Math.max(m, s.spanU, s.spanV), 0) || 1;
      faceSizes = spans.map(s => ({
        w: Math.max(1, s.spanU / maxSpan),
        h: Math.max(1, s.spanV / maxSpan),
      }));
    } else {
      // Todas iguales (1×1 normalizado, se escala al final)
      faceSizes = meshFaces.map(() => ({ w: 1, h: 1 }));
    }

    const cubeSizes = cubeFaceList.map(() => ({ w: 1, h: 1 }));
    const allSizes  = [...faceSizes, ...cubeSizes];

    // ── Layout en grilla (coordenadas normalizadas) ────────────────────────
    const cols = Math.ceil(Math.sqrt(total));
    const rawPos = [];
    let cx = 0, cy = 0, rowH = 0;

    // padding normalizado relativo al tamaño de celda unitario
    const pxN = padX / outW;
    const pyN = padY / outH;

    allSizes.forEach((sz, i) => {
      if (i > 0 && i % cols === 0) {
        cy  += rowH + pyN;
        cx   = 0;
        rowH = 0;
      }
      rawPos.push({ px: cx + pxN, py: cy + pyN, cw: sz.w, ch: sz.h });
      cx  += sz.w + pxN * 2;
      rowH = Math.max(rowH, sz.h);
    });

    // ── Tamaño total del layout ────────────────────────────────────────────
    const layoutW = rawPos.reduce((m, p) => Math.max(m, p.px + p.cw + pxN), 0);
    const layoutH = rawPos.reduce((m, p) => Math.max(m, p.py + p.ch + pyN), 0);

    // ── Escalar para que quepa exactamente en outW × outH ─────────────────
    const scaleX = outW / layoutW;
    const scaleY = outH / layoutH;

    const positions = rawPos.map(p => ({
      px: Math.round(p.px * scaleX),
      py: Math.round(p.py * scaleY),
      cw: Math.max(1, Math.round(p.cw * scaleX)),
      ch: Math.max(1, Math.round(p.ch * scaleY)),
    }));

    // ── Escribir UVs ───────────────────────────────────────────────────────
    Undo.initEdit({ elements: [...targetMeshes, ...targetCubes] });

    meshFaces.forEach(({ mesh, fk }, i) => {
      const { px, py, cw, ch } = positions[i];
      mapFaceToCell(mesh, fk, px, py, cw, ch);
    });

    cubeFaceList.forEach(({ cube, n }, i) => {
      const { px, py, cw, ch } = positions[meshFaces.length + i];
      cube.faces[n].uv       = [px, py, px + cw, py + ch];
      cube.faces[n].rotation = 0;
    });

    Undo.finishEdit("Cape UV");
    Canvas.updateAll();
    Blockbench.showQuickMessage(`✓ Cape UV · ${total} faces · ${outW}×${outH}px`, 2500);
  }

  // ── Extensión real de una face en su plano tangente ─────────────────────
  function getFaceSpan(mesh, faceKey) {
    const face   = mesh.faces[faceKey];
    const [U, V] = buildTangentBasis(getFaceNormal(mesh, faceKey));
    let minU=Infinity, maxU=-Infinity, minV=Infinity, maxV=-Infinity;
    face.vertices.forEach(vid => {
      const p = mesh.vertices[vid];
      const u = dot3(p, U), v = dot3(p, V);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    });
    return { spanU: Math.max(0.001, maxU - minU), spanV: Math.max(0.001, maxV - minV) };
  }

  // ── Mapear vértices de una face a esquinas de la celda ──────────────────
  function mapFaceToCell(mesh, faceKey, px, py, cw, ch) {
    const face = mesh.faces[faceKey];
    if (!face.uv) face.uv = {};
    const sorted = sortVertsConvex(mesh, faceKey);
    const n      = sorted.length;

    if (n === 3) {
      face.uv[sorted[0]] = [px,      py     ];
      face.uv[sorted[1]] = [px + cw, py     ];
      face.uv[sorted[2]] = [px,      py + ch];
    } else {
      const corners = [
        [px,      py     ],
        [px + cw, py     ],
        [px + cw, py + ch],
        [px,      py + ch],
      ];
      for (let i = 0; i < Math.min(n, 4); i++) {
        face.uv[sorted[i]] = corners[i];
      }
    }
  }

  function sortVertsConvex(mesh, faceKey) {
    const face   = mesh.faces[faceKey];
    const vids   = face.vertices;
    const [U, V] = buildTangentBasis(getFaceNormal(mesh, faceKey));
    const proj   = vids.map(vid => {
      const p = mesh.vertices[vid];
      return { vid, u: dot3(p, U), v: dot3(p, V) };
    });
    const cu = proj.reduce((s, p) => s + p.u, 0) / proj.length;
    const cv = proj.reduce((s, p) => s + p.v, 0) / proj.length;
    proj.sort((a, b) => Math.atan2(a.v - cv, a.u - cu) - Math.atan2(b.v - cv, b.u - cu));
    return proj.map(p => p.vid);
  }

  function getFaceNormal(mesh, faceKey) {
    const f = mesh.faces[faceKey];
    const v = f.vertices.map(id => mesh.vertices[id]);
    if (v.length < 3) return [0, 1, 0];
    return normalize3(cross3(sub3(v[1],v[0]), sub3(v[2],v[0])));
  }

  function buildTangentBasis(n) {
    const up = Math.abs(n[1]) < 0.99 ? [0,1,0] : [1,0,0];
    const U  = normalize3(cross3(up, n));
    const V  = normalize3(cross3(n, U));
    return [U, V];
  }

  function sub3(a,b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function dot3(a,b)   { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
  function cross3(a,b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function normalize3(v) {
    const l = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]) || 1;
    return [v[0]/l, v[1]/l, v[2]/l];
  }
})();