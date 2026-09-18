// Reconstrução do contador (só o dono, via STATS_TOKEN). Recebe os totais
// DIÁRIOS por sistema e faz SET nas chaves `downloads:{f}:{dia}` que estão
// ZERADAS (idempotente: rodar de novo não duplica). Os acumulados
// `downloads:{f}:total` ganham o que foi reconstruído POR CIMA do valor atual,
// então um clique que caia durante a operação não é perdido.
import { Redis } from "@upstash/redis";

const FILES = ["macos", "windows", "linux"];

function candidatos() {
  const pares = [
    [process.env.KV_REST_API_URL, process.env.KV_REST_API_TOKEN],
    [process.env.UPSTASH_REDIS_REST_URL, process.env.UPSTASH_REDIS_REST_TOKEN],
  ];
  const vistos = new Set();
  return pares.filter(([url, token]) => {
    if (!url || !token || vistos.has(url)) return false;
    vistos.add(url);
    return true;
  });
}

async function getRedis() {
  let ultimo = null;
  for (const [url, token] of candidatos()) {
    const cliente = new Redis({ url, token });
    try {
      await cliente.get("magicstat:probe");
      return cliente;
    } catch (err) {
      ultimo = err;
    }
  }
  throw ultimo || new Error("sem banco Redis acessível");
}

export default async function handler(req, res) {
  const esperado = process.env.STATS_TOKEN;
  const token = String(req.query.token || req.headers["x-stats-token"] || "");
  if (!esperado || token !== esperado) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  let dados;
  try {
    dados = JSON.parse(String(req.query.dados || "{}"));
  } catch (err) {
    return res.status(400).json({ ok: false, error: "dados inválidos (JSON)" });
  }
  const dias = dados && typeof dados.dias === "object" ? dados.dias : {};
  if (!Object.keys(dias).length) {
    return res.status(400).json({ ok: false, error: "sem dias para reconstruir" });
  }

  try {
    const cliente = await getRedis();
    const aplicado = {};
    const somado = {};
    for (const f of FILES) somado[f] = 0;

    for (const [dia, por] of Object.entries(dias)) {
      aplicado[dia] = {};
      for (const f of FILES) {
        const n = Number((por && por[f]) || 0);
        const atual = Number((await cliente.get(`downloads:${f}:${dia}`)) || 0);
        if (atual === 0 && n > 0) {
          await cliente.set(`downloads:${f}:${dia}`, n);
          somado[f] += n;
          aplicado[dia][f] = n;
        } else {
          aplicado[dia][f] = atual;
        }
      }
    }

    const totais = {};
    for (const f of FILES) {
      const atual = Number((await cliente.get(`downloads:${f}:total`)) || 0);
      const novo = atual + somado[f];
      await cliente.set(`downloads:${f}:total`, novo);
      totais[f] = novo;
    }
    totais.total = FILES.reduce((acc, f) => acc + totais[f], 0);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, aplicado, somado, totais });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: "server_error",
      message: String(err?.message ?? err),
    });
  }
}
