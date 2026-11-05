#!/usr/bin/env python3
"""Create the synthetic, password-protected statement PDFs used by the tests.

Every merchant, amount and date here is invented. Never put a real statement
in this repository.

Needs: pip install pypdf cryptography
Usage: python3 tools/make_fixtures.py
"""
import io, json, os
from pypdf import PdfReader, PdfWriter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "tests", "fixtures")
PASSWORD = "test-1234"  # test value for synthetic files only


def pdf_from_lines(pages):
    """pages: list of lists of rows; each row is a list of (x, text). Builds a minimal text PDF."""
    objs = []
    def add(b):
        objs.append(b); return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    page_ids = []
    content_ids = []
    for rows in pages:
        ops = []
        y = 800
        for row in rows:
            for x, text in row:
                t = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                ops.append(f"BT /F1 9 Tf {x} {y} Td ({t}) Tj ET")
            y -= 16
        stream = "\n".join(ops).encode("latin-1")
        cid = add(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream")
        content_ids.append(cid)
        page_ids.append(add(b"PAGE"))
    pages_obj = add(b"PAGES")
    for pid, cid in zip(page_ids, content_ids):
        objs[pid - 1] = (b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_obj, font, cid))
    objs[pages_obj - 1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % p for p in page_ids), len(page_ids))
    catalog = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj)
    out = io.BytesIO(); out.write(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(out.tell()); out.write(b"%d 0 obj\n" % i + o + b"\nendobj\n")
    x = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1))
    for o in offs: out.write(b"%010d 00000 n \n" % o)
    out.write(b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, catalog, x))
    return out.getvalue()


def encrypt(raw, algorithm):
    r = PdfReader(io.BytesIO(raw)); w = PdfWriter()
    for p in r.pages: w.add_page(p)
    w.encrypt(user_password=PASSWORD, owner_password="owner-" + PASSWORD, algorithm=algorithm)
    b = io.BytesIO(); w.write(b); return b.getvalue()


# Layout A: dd/mm/yyyy dates, transaction + posting date, separate amount column
A_ROWS = [
    [(40, "EXAMPLE TEST BANK - SYNTHETIC CREDIT CARD STATEMENT (INVENTED DATA)")],
    [(40, "Card number"), (200, "XXXX XXXX XXXX 0000")],
    [(40, "Statement Date"), (200, "15/10/2026")],
    [(40, "Payment Due Date"), (200, "09/11/2026")],
    [(40, "Credit Limit"), (200, "20,000.00")],
    [(40, "Total Amount Due"), (200, "1,876.71")],
    [],
    [(40, "Txn Date"), (110, "Post Date"), (180, "Description"), (420, "Amount (AED)")],
    [(40, "18/09/2026"), (110, "19/09/2026"), (180, "PREVIOUS BALANCE"), (420, "1,000.00")],
    [(40, "20/09/2026"), (110, "21/09/2026"), (180, "TESTMART HYPERMARKET DUBAI"), (420, "245.50")],
    [(40, "22/09/2026"), (110, "23/09/2026"), (180, "STREAMFLIX.COM"), (330, "USD 15.99"), (420, "58.72")],
    [(40, "25/09/2026"), (110, "26/09/2026"), (180, "ADNOC SAMPLE STATION 999"), (420, "120.00")],
    [(40, "28/09/2026"), (110, "28/09/2026"), (180, "PAYMENT RECEIVED - THANK YOU"), (420, "1,000.00 CR")],
    [(40, "01/10/2026"), (110, "02/10/2026"), (180, "PRETEND CAFE JUMEIRAH"), (420, "38.00")],
    [(40, "03/10/2026"), (110, "04/10/2026"), (180, "REFUND TESTMART HYPERMARKET"), (420, "45.50 CR")],
    [(40, "10/10/2026"), (110, "11/10/2026"), (180, "IMAGINARY AIRWAYS 1234567890"), (420, "1,414.49")],
    [(40, "Total purchases"), (420, "1,876.71")],
]
A_EXPECT = [
    {"date": "2026-09-20", "description": "TESTMART HYPERMARKET DUBAI", "aed": 245.5, "amount": 245.5, "currency": "AED", "type": "charge"},
    {"date": "2026-09-22", "description": "STREAMFLIX.COM", "aed": 58.72, "amount": 15.99, "currency": "USD", "type": "charge"},
    {"date": "2026-09-25", "description": "ADNOC SAMPLE STATION 999", "aed": 120.0, "amount": 120.0, "currency": "AED", "type": "charge"},
    {"date": "2026-09-28", "description": "PAYMENT RECEIVED - THANK YOU", "aed": 1000.0, "amount": 1000.0, "currency": "AED", "type": "payment"},
    {"date": "2026-10-01", "description": "PRETEND CAFE JUMEIRAH", "aed": 38.0, "amount": 38.0, "currency": "AED", "type": "charge"},
    {"date": "2026-10-03", "description": "REFUND TESTMART HYPERMARKET", "aed": 45.5, "amount": 45.5, "currency": "AED", "type": "credit"},
    {"date": "2026-10-10", "description": "IMAGINARY AIRWAYS", "aed": 1414.49, "amount": 1414.49, "currency": "AED", "type": "charge"},
]

# Layout B: "12 Oct" dates without a year, spanning a year end, two pages
B_ROWS_1 = [
    [(40, "SAMPLE FINANCE PJSC - TEST STATEMENT (NOT A REAL ACCOUNT)")],
    [(40, "Statement Period"), (200, "16 Dec 2026 to 15 Jan 2027")],
    [(40, "Due Date"), (200, "10 Feb 2027")],
    [],
    [(40, "Date"), (120, "Details"), (440, "Amount")],
    [(40, "18 Dec"), (120, "FAKEFOODS DELIVERY"), (440, "64.25")],
    [(40, "24 Dec"), (120, "MOCK CINEMAS MALL"), (440, "95.00")],
]
B_ROWS_2 = [
    [(40, "Date"), (120, "Details"), (440, "Amount")],
    [(40, "02 Jan"), (120, "DEMO PHARMACY 22"), (440, "33.10")],
    [(40, "09 Jan"), (120, "EXAMPLE TELECOM BILL"), (440, "299.00")],
    [(40, "Closing balance"), (440, "491.35")],
]
B_EXPECT = [
    {"date": "2026-12-18", "description": "FAKEFOODS DELIVERY", "aed": 64.25, "amount": 64.25, "currency": "AED", "type": "charge"},
    {"date": "2026-12-24", "description": "MOCK CINEMAS MALL", "aed": 95.0, "amount": 95.0, "currency": "AED", "type": "charge"},
    {"date": "2027-01-02", "description": "DEMO PHARMACY 22", "aed": 33.1, "amount": 33.1, "currency": "AED", "type": "charge"},
    {"date": "2027-01-09", "description": "EXAMPLE TELECOM BILL", "aed": 299.0, "amount": 299.0, "currency": "AED", "type": "charge"},
]


def main():
    os.makedirs(OUT, exist_ok=True)
    a = pdf_from_lines([A_ROWS]); b = pdf_from_lines([B_ROWS_1, B_ROWS_2])
    files = {
        "statement-a-plain.pdf": a,
        "statement-a-aes256.pdf": encrypt(a, "AES-256"),
        "statement-a-rc4.pdf": encrypt(a, "RC4-128"),
        "statement-b-aes128.pdf": encrypt(b, "AES-128"),
    }
    for n, data in files.items():
        open(os.path.join(OUT, n), "wb").write(data)
    expected = {
        "password": PASSWORD,
        "a": {"statementDate": "2026-10-15", "dueDate": "2026-11-09", "txs": A_EXPECT},
        "b": {"statementDate": "2027-01-15", "dueDate": "2027-02-10", "txs": B_EXPECT},
    }
    json.dump(expected, open(os.path.join(OUT, "statements-expected.json"), "w"), indent=1)
    print("wrote", ", ".join(files))


if __name__ == "__main__":
    main()
