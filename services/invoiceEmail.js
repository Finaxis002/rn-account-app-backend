// services/invoiceEmail.js
const { _internal } = require("../controllers/integrations/gmailController"); // uses sendWithClientGmail()
const EmailIntegration = require("../models/EmailIntegration");
const Party = require("../models/Party");
const Company = require("../models/Company");


// ---- invoice email template (email-safe) ----
const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });
const money = (n, cur = INR) => cur.format(Number(n || 0));
const pad2 = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => {
  const dt = d ? new Date(d) : new Date();
  return `${pad2(dt.getDate())} ${dt.toLocaleString("en-US", { month: "short" })} ${dt.getFullYear()}`;
};
const rn = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;

const invNo = (sale) =>
  sale?.referenceNumber?.trim()
    ? sale.referenceNumber
    : `INV-${String(sale?._id || "").slice(-6).toUpperCase()}`;

// Defensive name/code helpers for different doc shapes
// Replace these functions in your invoice template
const productName = (item) => {
  if (item?.product && typeof item.product === "object") {
    return item.product.name || item.product.productName || "Item";
  }
  return item?.name || item?.productName || "Item";
};

const productCode = (item) => {
  if (item?.product && typeof item.product === "object") {
    return item.product.hsn || item.product.code || item.product.sku || "";
  }
  return item?.hsn || item?.code || item?.sku || "";
};

const serviceName = (item) => {
  if (item?.service && typeof item.service === "object") {
    return item.service.serviceName || item.service.name || item.description || "Service";
  }
  return item?.serviceName || item?.description || "Service";
};

const serviceCode = (item) => {
  if (item?.service && typeof item.service === "object") {
    return item.service.sac || "";
  }
  return item?.sac || "";
};

function renderInvoiceHtml({ sale, party, company, currency = "INR", logoUrl, heroUrl }) {
  // 1) Merge product + service lines
  const lines = [];
  // Update the item processing section
  (sale.products || []).forEach((item) => {
    lines.push({
      type: "product",
      name: productName(item),
      code: productCode(item),
      unit: item.unitType || "",
      qty: item.quantity ?? "",
      rate: item.pricePerUnit ?? "",
      amount: item.amount ?? 0,
      desc: item.description || "",
    });
  });

  (sale.service || []).forEach((item) => {
    lines.push({
      type: "service",
      name: serviceName(item),
      code: serviceCode(item),
      unit: "",
      qty: "",
      rate: "",
      amount: item.amount ?? 0,
      desc: item.description || "",
    });
  });
  // 2) Totals (subtotal → discount → GST → grand total)
  const subTotal = rn(lines.reduce((a, b) => a + Number(b.amount || 0), 0));
  const discountPct = Number(sale.discountPercentage || 0);
  const discountAmt = rn(subTotal * (discountPct / 100));
  const taxable = rn(subTotal - discountAmt);
  const gstPct = Number(sale.gstPercentage || 0);
  const gstAmt = rn(taxable * (gstPct / 100));
  const grandTotal = sale.totalAmount != null ? rn(sale.totalAmount) : rn(taxable + gstAmt);

  const issuedOn = fmtDate(sale.date);
  const dueOn = sale.dueDate ? fmtDate(sale.dueDate) : fmtDate(new Date(new Date(sale.date || Date.now()).getTime() + 30 * 24 * 3600 * 1000));

  // 3) Build table rows
  const rowsHtml = lines.map((l, i) => `
      <tr>
        <td style="padding:8px;border:1px solid #e5e7eb;">${i + 1}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;">
          <div style="font-weight:600">${l.name}</div>
          ${l.code ? `<div style="color:#6b7280;font-size:12px">Code: ${l.code}</div>` : ""}
          ${l.desc && l.type === "service" ? `<div style="color:#6b7280;font-size:12px">${l.desc}</div>` : ""}
        </td>
        <td style="padding:8px;border:1px solid #e5e7eb;">${l.unit || "—"}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${l.qty || "—"}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${l.rate !== "" ? money(l.rate) : "—"}</td>
        <td style="padding:8px;border:1px solid #e5e7eb;text-align:right">${money(l.amount)}</td>
      </tr>
  `).join("");

  // 4) HTML (email-safe, no external fonts, mostly inline CSS)
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;">
    <div style="max-width:720px;margin:0 auto;padding:24px;">
      ${heroUrl ? `<div style="height:160px;background:url('${heroUrl}') center/cover no-repeat;border-radius:12px 12px 0 0;"></div>` : ""}

      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden;">

        <!-- Top -->
        <div style="padding:20px 24px;border-bottom:1px solid #e5e7eb;display:flex;gap:16px;align-items:center;justify-content:space-between;">
          <div style="display:flex;gap:12px;align-items:center;">
            ${logoUrl ? `<img src="${logoUrl}" alt="Logo" width="48" height="48" style="border-radius:8px;display:block;">` : ""}
            <div>
              <div style="font-size:18px;font-weight:700">${company?.businessName || "Your Business"}</div>
              ${company?.gstin ? `<div style="font-size:12px;color:#6b7280">GSTIN: ${company.gstin}</div>` : ""}
              ${company?.email ? `<div style="font-size:12px;color:#6b7280">${company.email}</div>` : ""}
            </div>
          </div>

          <div style="text-align:right">
            <div style="font-size:18px;font-weight:700">Invoice</div>
            <div style="font-size:12px;color:#6b7280">#${invNo(sale)}</div>
            <div style="font-size:12px;color:#6b7280">Issued: ${issuedOn}</div>
            <div style="font-size:12px;color:#6b7280">Due: ${dueOn}</div>
          </div>
        </div>

        <!-- Mid: Bill To / From -->
        <div style="padding:16px 24px;display:flex;gap:24px;">
          <div style="flex:1">
            <div style="font-weight:700;margin-bottom:4px">Bill To</div>
            <div>${party?.name || "Customer"}</div>
            ${party?.email ? `<div style="color:#6b7280;font-size:12px">${party.email}</div>` : ""}
            ${party?.address ? `<div style="color:#6b7280;font-size:12px">${party.address}</div>` : ""}
          </div>
          <div style="flex:1">
            <div style="font-weight:700;margin-bottom:4px">From</div>
            <div>${company?.businessName || ""}</div>
            ${company?.address ? `<div style="color:#6b7280;font-size:12px">${company.address}</div>` : ""}
          </div>
        </div>

        <!-- Items -->
        <div style="padding:8px 24px 16px;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
            <thead>
              <tr>
                <th align="left" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">#</th>
                <th align="left" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">Item / Service</th>
                <th align="left" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">Unit</th>
                <th align="right" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">Qty</th>
                <th align="right" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">Rate</th>
                <th align="right" style="padding:10px;border:1px solid #e5e7eb;background:#f1f5f9;font-size:12px;">Amount</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml || `<tr><td colspan="6" style="padding:12px;border:1px solid #e5e7eb;color:#6b7280;text-align:center">No lines</td></tr>`}
            </tbody>
          </table>
        </div>

        <!-- Totals -->
        <div style="padding:8px 24px 20px;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
            <tr>
              <td style="width:60%"></td>
              <td style="width:40%">
                <table width="100%" cellpadding="6" cellspacing="0" role="presentation" style="border-collapse:collapse;">
                  <tr>
                    <td>Subtotal</td>
                    <td align="right">${money(subTotal)}</td>
                  </tr>
                  ${discountPct ? `<tr><td>Discount (${discountPct}%)</td><td align="right">-${money(discountAmt)}</td></tr>` : ""}
                  ${gstPct ? `<tr><td>GST (${gstPct}%)</td><td align="right">${money(gstAmt)}</td></tr>` : ""}
                  <tr>
                    <td style="border-top:1px solid #e5e7eb;font-weight:700;padding-top:8px;">Grand Total</td>
                    <td align="right" style="border-top:1px solid #e5e7eb;font-weight:700;padding-top:8px;">${money(grandTotal)}</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </div>

        <!-- Footer -->
        <div style="background:#f8fafc;padding:14px 24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;">
          <strong>Thank you for your business!</strong> If you have any questions, just reply to this email.
        </div>
      </div>
    </div>
  </body>
</html>`;
}



exports.sendInvoiceFromClientPdf = async (req, res) => {
  try {
    const clientId = req.user.id;
    const {
      pdfBase64,
      filename,
      partyId,
      companyId,
      to: toOverride,
      subject: subjectOverride,
      message: messageOverride,
    } = req.body || {};

    if (!pdfBase64) {
      return res.status(400).json({ message: "Missing pdfBase64" });
    }

    // Who to email + branding for the message
    const [party, company] = await Promise.all([
      partyId ? Party.findById(partyId).lean() : null,
      companyId ? Company.findById(companyId).lean() : null,
    ]);

    const to = toOverride || party?.email;
    if (!to) return res.status(400).json({ message: "Recipient email not provided" });

    const partyName = party?.name || "Customer";
    const companyName = company?.businessName || "Your Company";
    const companyEmail = company?.emailId || company?.email || "support@example.com";
    const companyPhone = company?.mobileNumber || company?.phone || "";

    // Subject + message (your requested text, can be overridden by client)
    const subject = subjectOverride || `Invoice Form ${companyName}`;
    const html =
      messageOverride ||
      `
      <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;color:#111;">
        <p>Dear ${partyName},</p>
        <p>
          Thank you for choosing <strong>${companyName}</strong>. Please find attached the invoice
          for your recent purchase.
        </p>
        <p>We appreciate your business and look forward to serving you again.</p>
        <p>
          For any queries, feel free to contact us at
          <a href="mailto:${companyEmail}">${companyEmail}</a>
          ${companyPhone ? ` or <a href="tel:${companyPhone}">${companyPhone}</a>` : ""}.
        </p>
        <p style="margin-top:16px;">
          Warm regards,<br/>
          ${companyName}<br/>
          ${companyEmail}
        </p>
      </div>
      `;

    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    await exports._internal.sendWithClientGmail({
      clientId,
      fromName: companyName,
      to,
      subject,
      html,
      attachments: [
        {
          filename: filename || "Invoice.pdf",
          content: pdfBuffer,
          contentType: "application/pdf",
        },
      ],
    });

    res.json({ ok: true });
  } catch (e) {
    const msg = e?.message || "Failed to send";
    // When refresh token is invalid/revoked, sendWithClientGmail already marks disconnected.
    if (/Gmail access was revoked/i.test(msg)) {
      return res
        .status(401)
        .json({ code: "gmail_reconnect_required", message: msg });
    }
    res.status(400).json({ message: msg });
  }
};

/**
 * Sends the sales invoice FROM the client’s connected Gmail TO the party’s email.
 * Throws only if you call it directly; in controllers, call inside setImmediate to avoid blocking.
 */
async function sendSalesInvoiceEmail({ clientId, sale, partyId, companyId }) {
  // ensure client actually connected Gmail
  const integ = await EmailIntegration.findOne({ client: clientId, connected: true }).lean();
  if (!integ?.refreshToken) {
    throw new Error("Client has not connected Gmail");
  }

  // fetch party & company info (or you can pass them in if you already have them)
  const [party, company] = await Promise.all([
    Party.findById(partyId || sale.party).lean(),
    Company.findById(companyId || sale.company).lean(),
  ]);

  if (!party?.email) throw new Error("Party has no email");

  const subject = `Invoice ${sale.referenceNumber || sale._id} - ${company?.businessName || "Invoice"}`;
  const html = renderInvoiceHtml({ sale, party, company });

  await _internal.sendWithClientGmail({
    clientId,
    fromName: company?.businessName || undefined,
    to: party.email,
    subject,
    html,
    // attachments: [{ filename: 'Invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' }]
  });
}

module.exports = { sendSalesInvoiceEmail };
