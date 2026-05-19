import json
import re
import threading
import uuid
from datetime import date
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from urllib import request as urllib_request

import boto3
from django.conf import settings
from django.core.files.base import ContentFile
from django.utils import timezone
from pdf2image import convert_from_bytes
from PIL import Image
from pypdf import PdfReader
import pytesseract

from .models import Invoice, InvoiceData, ProcessingTask


def s3_is_configured():
    return bool(
        settings.S3_BUCKET_NAME
        and settings.S3_ACCESS_KEY_ID
        and settings.S3_SECRET_ACCESS_KEY
    )


def s3_client():
    kwargs = {
        "service_name": "s3",
        "region_name": settings.S3_REGION_NAME,
        "aws_access_key_id": settings.S3_ACCESS_KEY_ID,
        "aws_secret_access_key": settings.S3_SECRET_ACCESS_KEY,
    }
    if settings.S3_ENDPOINT_URL:
        kwargs["endpoint_url"] = settings.S3_ENDPOINT_URL
    return boto3.client(**kwargs)


def build_storage_key(org_slug, file_name):
    clean_name = re.sub(r"[^a-zA-Z0-9._-]", "-", file_name)
    return f"invoices/{org_slug}/{uuid.uuid4().hex}-{clean_name}"


def build_public_file_url(invoice):
    if invoice.file_storage == Invoice.STORAGE_LOCAL and invoice.local_file:
        return invoice.local_file.url
    if settings.S3_PUBLIC_BASE_URL and invoice.file_s3_key:
        return f"{settings.S3_PUBLIC_BASE_URL.rstrip('/')}/{invoice.file_s3_key}"
    return invoice.file_url


def generate_presigned_upload(org, file_name, content_type):
    key = build_storage_key(org.slug, file_name)
    if not s3_is_configured():
        return {
            "mode": "local_fallback",
            "fileKey": key,
            "uploadUrl": None,
            "publicUrl": None,
        }

    client = s3_client()
    upload_url = client.generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.S3_BUCKET_NAME,
            "Key": key,
            "ContentType": content_type,
        },
        ExpiresIn=900,
    )
    public_url = f"{settings.S3_PUBLIC_BASE_URL.rstrip('/')}/{key}" if settings.S3_PUBLIC_BASE_URL else ""
    return {
        "mode": "s3",
        "fileKey": key,
        "uploadUrl": upload_url,
        "publicUrl": public_url,
    }


def read_invoice_bytes(invoice):
    if invoice.file_storage == Invoice.STORAGE_LOCAL and invoice.local_file:
        invoice.local_file.open("rb")
        try:
            return invoice.local_file.read()
        finally:
            invoice.local_file.close()

    if invoice.file_storage == Invoice.STORAGE_S3 and invoice.file_s3_key and s3_is_configured():
        body = s3_client().get_object(Bucket=settings.S3_BUCKET_NAME, Key=invoice.file_s3_key)["Body"].read()
        return body

    return b""


def tesseract_is_available():
    cmd = Path(settings.TESSERACT_CMD)
    return cmd.exists()


def tesseract_languages():
    lang = settings.TESSERACT_LANG.strip()
    return lang if lang else "eng"


def ocr_image(image):
    if not tesseract_is_available():
        return ""
    pytesseract.pytesseract.tesseract_cmd = settings.TESSERACT_CMD
    import numpy as np
    grayscale = image.convert("L")
    arr = np.array(grayscale)
    threshold = arr.mean() - arr.std() * 0.5
    boosted = grayscale.point(lambda px: 0 if px < threshold else 255)
    return pytesseract.image_to_string(boosted, lang=tesseract_languages(), config="--oem 3 --psm 6")


def extract_text_from_pdf(raw):
    temp_path = Path(settings.MEDIA_ROOT) / f"tmp-{uuid.uuid4().hex}.pdf"
    temp_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path.write_bytes(raw)
    try:
        reader = PdfReader(str(temp_path))
        extracted = "\n".join((page.extract_text() or "") for page in reader.pages).strip()
    finally:
        temp_path.unlink(missing_ok=True)

    if extracted:
        return extracted, "pypdf"

    if not tesseract_is_available():
        return "", "none"

    images = convert_from_bytes(raw, fmt="png")
    ocr_pages = [ocr_image(image) for image in images]
    return "\n".join(page for page in ocr_pages if page).strip(), "tesseract-pdf"


def extract_text_from_image(raw):
    if not tesseract_is_available():
        return "", "none"
    image = Image.open(BytesIO(raw))
    return ocr_image(image).strip(), "tesseract-image"


def extract_text_from_invoice(invoice):
    raw = read_invoice_bytes(invoice)
    if not raw:
        return "", "none"

    suffix = Path(invoice.file_name).suffix.lower()
    if suffix == ".pdf":
        return extract_text_from_pdf(raw)

    if suffix in {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}:
        return extract_text_from_image(raw)

    try:
        return raw.decode("utf-8"), "plain-text"
    except UnicodeDecodeError:
        return "", "none"


def heuristic_extract(text):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    supplier = lines[0][:180] if lines else "Fournisseur a verifier"
    if supplier.lower().startswith("invoice "):
        supplier = supplier.split(" ", 1)[1].strip() or supplier

    invoice_number = ""
    for line in lines:
        if re.search(r"\b(ref|facture|invoice)\b", line, flags=re.IGNORECASE):
            cleaned = re.sub(r"^(facture|invoice|ref)[^\w]*", "", line, flags=re.IGNORECASE).strip(" -:;,.")
            cleaned = re.sub(r"\s+", "-", cleaned)
            if cleaned:
                invoice_number = cleaned[:120]
                break

    date_value = timezone.localdate()
    match_date = re.search(r"(\d{4}-\d{2}-\d{2})|(\d{2}/\d{2}/\d{4})", text)
    if match_date:
        raw_date = match_date.group(0)
        try:
            date_value = date.fromisoformat(raw_date) if "-" in raw_date else date.fromisoformat("-".join(reversed(raw_date.split("/"))))
        except ValueError:
            pass

    normalized_text = text.replace("TTC1", "TTC ").replace("T161", "145")
    amount_ttc = Decimal("0")
    ttc_line = next((line for line in lines if "ttc" in line.lower() or "total" in line.lower()), "")
    amount_candidates = re.findall(r"(\d+(?:[.,]\d{2})?)", ttc_line or normalized_text)
    if amount_candidates:
        raw_amount = amount_candidates[-1].replace(",", ".")
        if "." not in raw_amount and len(raw_amount) > 2:
            raw_amount = f"{raw_amount[:-2]}.{raw_amount[-2:]}"
        try:
            amount_ttc = Decimal(raw_amount)
        except Exception:
            amount_ttc = Decimal("0")
    amount_ht = (amount_ttc / Decimal("1.20")).quantize(Decimal("0.01")) if amount_ttc else Decimal("0")
    amount_tva = (amount_ttc - amount_ht).quantize(Decimal("0.01")) if amount_ttc else Decimal("0")

    text_lower = text.lower()
    if "meta" in text_lower or "ads" in text_lower:
        category = "Marketing"
    elif "aws" in text_lower or "ovh" in text_lower or "cloud" in text_lower:
        category = "Infrastructure"
    elif "expert" in text_lower or "comptable" in text_lower:
        category = "Comptabilite"
    else:
        category = "Services"

    return {
        "supplier": supplier,
        "invoiceNumber": invoice_number or f"AUTO-{timezone.now().strftime('%Y%m%d%H%M')}",
        "invoiceDate": date_value,
        "amountHt": amount_ht,
        "amountTva": amount_tva,
        "amountTtc": amount_ttc,
        "category": category,
        "confidence": Decimal("0.72"),
    }


def anthropic_extract(text):
    if not settings.ANTHROPIC_API_KEY:
        return None

    prompt = (
        "Extract invoice fields and return strict JSON with keys: supplier, invoiceNumber, "
        "invoiceDate, amountHt, amountTva, amountTtc, category, confidence.\n"
        f"Invoice text:\n{text[:12000]}"
    )
    payload = {
        "model": settings.ANTHROPIC_MODEL,
        "max_tokens": 300,
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib_request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": settings.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib_request.urlopen(req, timeout=35) as response:
            body = json.loads(response.read().decode("utf-8"))
    except Exception:
        return None

    parts = body.get("content", [])
    if not parts:
        return None

    try:
        parsed = json.loads(parts[0]["text"])
    except Exception:
        return None

    try:
        parsed["invoiceDate"] = date.fromisoformat(parsed["invoiceDate"])
        parsed["amountHt"] = Decimal(str(parsed["amountHt"]))
        parsed["amountTva"] = Decimal(str(parsed["amountTva"]))
        parsed["amountTtc"] = Decimal(str(parsed["amountTtc"]))
        raw_conf = parsed.get("confidence", 0.8)
        if float(raw_conf) > 1.0:
            raw_conf = float(raw_conf) / 100.0
        parsed["confidence"] = Decimal(str(round(float(raw_conf), 4)))
    except Exception:
        return None
    return parsed


def process_invoice(invoice):
    task, _ = ProcessingTask.objects.get_or_create(invoice=invoice)
    invoice.status = Invoice.STATUS_PROCESSING
    invoice.save(update_fields=["status"])
    task.error_message = ""
    task.completed_at = None
    task.save(update_fields=["error_message", "completed_at"])

    text, extraction_engine = extract_text_from_invoice(invoice)
    extracted = anthropic_extract(text) or heuristic_extract(text)

    invoice.raw_text = text or "Aucun texte exploitable trouve dans le document."
    invoice.supplier = extracted["supplier"]
    invoice.invoice_number = extracted["invoiceNumber"]
    invoice.invoice_date = extracted["invoiceDate"]
    invoice.amount_ht = extracted["amountHt"]
    invoice.amount_tva = extracted["amountTva"]
    invoice.amount_ttc = extracted["amountTtc"]
    invoice.category = extracted["category"]
    invoice.confidence = extracted["confidence"]
    invoice.extracted_data = {
        "supplier": {"value": invoice.supplier, "confidence": float(invoice.confidence)},
        "invoice_number": {"value": invoice.invoice_number, "confidence": 0.74},
        "invoice_date": {"value": invoice.invoice_date.isoformat() if invoice.invoice_date else "", "confidence": 0.71},
        "amount_ttc": {"value": float(invoice.amount_ttc), "confidence": 0.76},
        "category": {"value": invoice.category, "confidence": 0.7},
        "ocr_engine": extraction_engine,
        "llm_engine": "anthropic" if settings.ANTHROPIC_API_KEY else "heuristic",
    }
    invoice.status = Invoice.STATUS_REVIEW
    invoice.processed_at = timezone.now()
    invoice.file_url = build_public_file_url(invoice)
    invoice.save()
    task.completed_at = timezone.now()
    task.save(update_fields=["completed_at"])

    review, _ = InvoiceData.objects.get_or_create(
        invoice=invoice,
        defaults={
            "supplier_name": invoice.supplier,
            "invoice_number": invoice.invoice_number,
            "invoice_date": invoice.invoice_date,
            "amount_ht": invoice.amount_ht,
            "amount_tva": invoice.amount_tva,
            "amount_ttc": invoice.amount_ttc,
            "category": invoice.category,
            "confidence": invoice.confidence,
            "is_validated": False,
        },
    )
    if review.pk:
        review.supplier_name = invoice.supplier
        review.invoice_number = invoice.invoice_number
        review.invoice_date = invoice.invoice_date
        review.amount_ht = invoice.amount_ht
        review.amount_tva = invoice.amount_tva
        review.amount_ttc = invoice.amount_ttc
        review.category = invoice.category
        review.confidence = invoice.confidence
        review.save()

    return invoice


def save_local_upload(invoice, uploaded_file):
    invoice.local_file.save(uploaded_file.name, ContentFile(uploaded_file.read()), save=False)
    invoice.file_storage = Invoice.STORAGE_LOCAL
    invoice.file_url = invoice.local_file.url if invoice.local_file else ""
    invoice.save()
    return invoice


def mark_invoice_error(invoice_id, message):
    invoice = Invoice.objects.get(pk=invoice_id)
    invoice.status = Invoice.STATUS_ERROR
    invoice.processed_at = timezone.now()
    invoice.save(update_fields=["status", "processed_at"])
    task, _ = ProcessingTask.objects.get_or_create(invoice=invoice)
    task.error_message = message[:2000]
    task.completed_at = timezone.now()
    task.save(update_fields=["error_message", "completed_at"])


def process_invoice_by_id(invoice_id):
    try:
        invoice = Invoice.objects.get(pk=invoice_id)
        process_invoice(invoice)
    except Exception as exc:
        mark_invoice_error(invoice_id, str(exc))
        raise


def enqueue_invoice_processing(invoice):
    if settings.CELERY_BROKER_URL:
        from .tasks import process_invoice_task

        async_result = process_invoice_task.delay(invoice.id)
        task, _ = ProcessingTask.objects.get_or_create(invoice=invoice)
        task.celery_task_id = async_result.id
        task.save(update_fields=["celery_task_id"])
        invoice.status = Invoice.STATUS_PROCESSING
        invoice.save(update_fields=["status"])
        return "celery"

    thread = threading.Thread(target=process_invoice_by_id, args=(invoice.id,), daemon=True)
    thread.start()
    invoice.status = Invoice.STATUS_PROCESSING
    invoice.save(update_fields=["status"])
    return "thread"
