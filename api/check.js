// Monitor diário de preços do enxoval. Roda via Vercel Cron às 8h (BRT).
// Env vars: ANTHROPIC_API_KEY, RESEND_API_KEY, EMAIL_TO, CRON_SECRET (opcional)

const ITEMS = [
  { nome: "Thule Sleek (carrinho, confirmar se vem com assento)", referencia: 6999, onde: "Mercado Livre" },
  { nome: "Moisés Thule Sleek (Bassinet)", referencia: 1614, onde: "Mercado Livre" },
  { nome: "Maxi-Cosi Pebble 360 Pro² + base FamilyFix 360 Pro", referencia: 3419, onde: "Mercado Livre / Pix" },
  { nome: "Base Maxi-Cosi FamilyFix 360 Pro (avulsa, 2º carro)", referencia: 1799, onde: "Amazon / Dom Bebê" },
  { nome: "Adaptador Maxi-Cosi para Thule Sleek", referencia: 589, onde: "Mercado Livre" },
  { nome: "Nanit Pro (babá eletrônica, kit com faixa de respiração)", referencia: 3720, onde: "Heyluli (Pix)" },
  { nome: "Bugaboo Butterfly 2 (carrinho de viagem, candidato)", referencia: 3185, onde: "MacroBaby" },
  { nome: "Stokke YOYO³ (carrinho de viagem, candidato)", referencia: 3599, onde: "varejo nacional" },
];

const brl = (n) =>
  typeof n === "number" ? n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) : "–";

function buildPrompt(hoje) {
  const lista = ITEMS.map((i) => `- ${i.nome} | referência: R$ ${i.referencia} (${i.onde})`).join("\n");
  return `Hoje é ${hoje}. Você monitora preços de itens de bebê no BRASIL para um pai cuja filha nasce em março de 2027.
A Black Friday brasileira de 2026 é em 27/11/2026.

Para cada item abaixo, pesquise na web o MENOR preço atual de produto NOVO vendido para o Brasil (lojas nacionais, Mercado Livre, Amazon.com.br, lojas especializadas; lojas que enviam do exterior só se o preço já incluir impostos). Ignore usados e anúncios sem preço.

${lista}

Depois decida para cada item: "COMPRAR" (preço bom vs referência e histórico, ou risco de faltar estoque), ou "ESPERAR" (ex.: Black Friday próxima, preço acima da referência). Seja direto.

Responda SOMENTE com JSON válido, sem markdown, neste formato:
{"itens":[{"nome":"...","menor_preco":1234.56,"loja":"...","link":"https://...","vs_referencia_pct":-5.2,"decisao":"COMPRAR|ESPERAR","motivo":"frase curta"}],"resumo":"2-3 frases com a recomendação geral do dia"}
Se não achar preço confiável de um item, use menor_preco null e explique no motivo.`;
}

async function askClaude(prompt) {
  const messages = [{ role: "user", content: prompt }];
  let data;
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || "claude-sonnet-5-5",
        max_tokens: 8000,
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 20, user_location: { type: "approximate", country: "BR", city: "São Paulo" } }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    data = await r.json();
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }
  const text = data.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

function renderEmail(res, hoje) {
  const rows = res.itens
    .map((it) => {
      const cor = it.decisao === "COMPRAR" ? "#1a7f37" : "#9a6700";
      const pct = typeof it.vs_referencia_pct === "number" ? `${it.vs_referencia_pct > 0 ? "+" : ""}${it.vs_referencia_pct.toFixed(1)}%` : "–";
      const preco = it.link ? `<a href="${it.link}">${brl(it.menor_preco)}</a>` : brl(it.menor_preco);
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee">${it.nome}<br><small style="color:#666">${it.loja || ""}</small></td>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">${preco}<br><small style="color:#666">${pct} vs ref.</small></td>
        <td style="padding:8px;border-bottom:1px solid #eee"><b style="color:${cor}">${it.decisao}</b><br><small>${it.motivo || ""}</small></td>
      </tr>`;
    })
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:640px">
    <h2 style="margin:0 0 8px">Enxoval: preços de ${hoje}</h2>
    <p style="margin:0 0 16px">${res.resumo}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">${rows}</table>
    <p style="color:#888;font-size:12px;margin-top:16px">Preços pesquisados automaticamente. Confira o anúncio antes de comprar.</p>
  </div>`;
}

async function sendEmail(html, hoje) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.RESEND_API_KEY}` },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || "Monitor Enxoval <onboarding@resend.dev>",
      to: process.env.EMAIL_TO.split(",").map((s) => s.trim()),
      subject: `Enxoval: preços de ${hoje}`,
      html,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const url = new URL(req.url, "http://x");
  if (secret && req.headers.authorization !== `Bearer ${secret}` && url.searchParams.get("key") !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const missing = ["ANTHROPIC_API_KEY", "RESEND_API_KEY", "EMAIL_TO"].filter((k) => !process.env[k]);
  if (missing.length) return res.status(500).json({ error: `Faltam env vars: ${missing.join(", ")}` });

  const hoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
  try {
    const result = await askClaude(buildPrompt(hoje));
    await sendEmail(renderEmail(result, hoje), hoje);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}

