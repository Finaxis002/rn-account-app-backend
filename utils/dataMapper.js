/**
 * Helper to ensure we send a standard ISO String for dates.
 * This prevents "Invalid Date" errors in the frontend.
 */

const formatSafeDate = (dateVal) => {
  if (!dateVal) return new Date().toISOString();
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return new Date().toISOString();

  // ✅ FIX: Agar time 18:30:00 UTC (IST midnight) hai toh current time inject karo
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const isJustDate =
    (hours === 18 && minutes === 30 && seconds === 0) ||
    (hours === 0 && minutes === 0 && seconds === 0);

  if (isJustDate) {
    const now = new Date();
    d.setUTCHours(
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    );
  }

  return d.toISOString();
};

/**
 * Map extracted OCR data → TransactionForm shape
 */
function mapToTransactionForm(extractedData, transactionType = "sales") {
  const items =
    extractedData.items?.length > 0
      ? extractedData.items.map((item) => {
          const base = Number(item.amount) || 0;
          const rawLineTax = Number(item.lineTax) || 0;

          // ─────────────────────────────────────────────────────────────
          // GST% SAFEGUARD:
          // Groq sometimes returns only CGST% (e.g. 9) instead of total (18).
          // ─────────────────────────────────────────────────────────────
          let pct = Number(item.gstPercentage) || 0;
          if (base > 0 && rawLineTax > 0) {
            const derivedPct = +((rawLineTax / base) * 100).toFixed(2);
            if (pct > 0 && derivedPct > pct * 1.4) {
              pct = derivedPct;
            } else if (pct === 0) {
              pct = derivedPct;
            }
          }
          if (pct === 0) pct = 18; // Default to 18 if still zero

          const lineTax = rawLineTax || +((base * pct) / 100).toFixed(2);
          const lineTotal =
            Number(item.lineTotal) || +(base + lineTax).toFixed(2);

          return {
            itemType: item.itemType || "product",
            product: item.product || "",
            hsn: item.hsn || "",
            quantity: item.quantity || 1,
            unitType: item.unitType || "Piece",
            otherUnit: "",
            pricePerUnit: item.pricePerUnit || 0,
            amount: base,
            gstPercentage: pct,
            lineTax,
            lineTotal,
            description: item.description || "",
          };
        })
      : [];

  const subTotal = Number(extractedData.subtotal || 0);
  const taxAmount = Number(extractedData.taxAmount || 0);
  const invoiceTotal = Number(
    extractedData.totalAmount > subTotal
      ? extractedData.totalAmount
      : +(subTotal + taxAmount).toFixed(2),
  );

  let shippingAddressDetails = null;
  let sameAsBilling = true;
  if (extractedData.address || extractedData.city || extractedData.state) {
    shippingAddressDetails = {
      label: "Shipping Address",
      address: extractedData.address || "",
      city: extractedData.city || "",
      state: extractedData.state || "",
      pincode: extractedData.pincode || "",
      contactNumber: extractedData.contactNumber || "",
    };
    sameAsBilling = false;
  }

  return {
    type: transactionType,
    party: extractedData.partyName || "",

    // ✅ Updated: Backend ab hamesha ISO String bhejega
    date: formatSafeDate(extractedData.date),
    dueDate: formatSafeDate(extractedData.dueDate || extractedData.date),

    referenceNumber: extractedData.invoiceNumber || "",
    paymentMethod: extractedData.paymentMethod || "",
    totalAmount: invoiceTotal,
    taxAmount,
    invoiceTotal,
    items,
    notes: extractedData.notes || "",
    sameAsBilling,
    shippingAddressDetails,
    _partyNameRaw: extractedData.partyName || "",
    _companyName: extractedData.companyName || "",
    _gstin: extractedData.gstin || "",
    _contactNumber: extractedData.contactNumber || "",
  };
}

function mapToPartyForm(extractedData) {
  return {
    name: extractedData.partyName || "",
    gstin: extractedData.gstin || "",
    address: extractedData.address || "",
    city: extractedData.city || "",
    state: extractedData.state || "",
    pincode: extractedData.pincode || "",
    contactNumber: extractedData.contactNumber || "",
    email: extractedData.email || "",
  };
}

function fuzzyMatchName(rawName, options) {
  if (!rawName || !options?.length) return null;
  const normalize = (s) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const raw = normalize(rawName);
  let bestScore = 0,
    bestValue = null;
  for (const opt of options) {
    const label = normalize(opt.label || "");
    let score = 0;
    if (raw === label) score = 100;
    else if (raw.includes(label) || label.includes(raw)) score = 80;
    else {
      const rawWords = new Set(raw.split(" ").filter((w) => w.length > 2));
      const labelWords = new Set(label.split(" ").filter((w) => w.length > 2));
      const overlap = [...rawWords].filter((w) => labelWords.has(w)).length;
      const total = Math.max(rawWords.size, labelWords.size, 1);
      score = Math.round((overlap / total) * 60);
    }
    if (score > bestScore) {
      bestScore = score;
      bestValue = opt.value;
    }
  }
  return bestScore >= 40 ? bestValue : null;
}

module.exports = { mapToTransactionForm, mapToPartyForm, fuzzyMatchName };
