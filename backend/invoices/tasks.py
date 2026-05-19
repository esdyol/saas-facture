from celery import shared_task

from .services import process_invoice_by_id


@shared_task(bind=True, autoretry_for=(Exception,), retry_backoff=True, retry_kwargs={"max_retries": 3})
def process_invoice_task(self, invoice_id):
    process_invoice_by_id(invoice_id)
    return {"invoice_id": invoice_id, "status": "processed"}
