from datetime import date, datetime, time, timedelta
from decimal import Decimal

from django.core.management.base import BaseCommand
from django.utils import timezone

from invoices.models import Invoice, InvoiceData, Organization, Subscription, User


class Command(BaseCommand):
    help = "Charge des donnees de demonstration pour le SaaS Factures IA."

    def handle(self, *args, **options):
        org, _ = Organization.objects.get_or_create(
            slug="atelier-nova",
            defaults={
                "name": "Atelier Nova",
                "plan": Organization.PLAN_PRO,
                "monthly_quota": 500,
                "stripe_customer_id": "cus_demo_2026",
            },
        )

        user, created = User.objects.get_or_create(
            username="owner",
            defaults={
                "email": "owner@ateliernova.test",
                "organization": org,
                "role": User.ROLE_OWNER,
            },
        )
        if created or not user.check_password("demo12345"):
            user.organization = org
            user.role = User.ROLE_OWNER
            user.set_password("demo12345")
            user.save()

        Subscription.objects.get_or_create(
            organization=org,
            defaults={
                "stripe_sub_id": "sub_demo_2026",
                "plan": Organization.PLAN_PRO,
                "status": Subscription.STATUS_ACTIVE,
                "current_period_end": date.today() + timedelta(days=27),
            },
        )

        samples = [
            ("ovh-avril-2026.pdf", "OVHcloud", "IT", Decimal("145.00"), 94, True, date.today() - timedelta(days=20)),
            ("meta-ads-mai-2026.pdf", "Meta Ads", "Marketing", Decimal("320.00"), 88, False, date.today() - timedelta(days=11)),
            ("station-work-fevrier.png", "Station Work", "Coworking", Decimal("89.90"), 79, True, date.today() - timedelta(days=45)),
            ("amazon-saas-licence.pdf", "Amazon Web Services", "Infrastructure", Decimal("210.50"), 91, False, date.today() - timedelta(days=6)),
            ("cabinet-comptable-mars.pdf", "Cabinet Expertis", "Comptabilite", Decimal("500.00"), 97, True, date.today() - timedelta(days=60)),
        ]

        for index, (file_name, supplier, category, amount_ttc, confidence, validated, invoice_date) in enumerate(samples, start=1):
            processed_at = timezone.make_aware(datetime.combine(invoice_date, time.min))
            invoice, created = Invoice.objects.get_or_create(
                organization=org,
                file_name=file_name,
                defaults={
                    "file_url": f"https://example.com/demo/{file_name}",
                    "file_s3_key": f"demo/{file_name}",
                    "status": Invoice.STATUS_DONE if validated else Invoice.STATUS_REVIEW,
                    "supplier": supplier,
                    "invoice_number": f"FAC-2026-{index:03d}",
                    "invoice_date": invoice_date,
                    "amount_ht": amount_ttc / Decimal("1.20"),
                    "amount_tva": amount_ttc - (amount_ttc / Decimal("1.20")),
                    "amount_ttc": amount_ttc,
                    "category": category,
                    "confidence": Decimal(str(confidence)),
                    "raw_text": f"Texte OCR demo pour {supplier}",
                    "extracted_data": {
                        "supplier": {"value": supplier, "confidence": confidence / 100},
                        "amount_ttc": {"value": float(amount_ttc), "confidence": confidence / 100},
                        "category": {"value": category, "confidence": 0.8},
                    },
                    "processed_at": processed_at,
                },
            )
            if created:
                InvoiceData.objects.create(
                    invoice=invoice,
                    supplier_name=supplier,
                    invoice_number=f"FAC-2026-{index:03d}",
                    invoice_date=invoice_date,
                    amount_ht=amount_ttc / Decimal("1.20"),
                    amount_tva=amount_ttc - (amount_ttc / Decimal("1.20")),
                    amount_ttc=amount_ttc,
                    category=category,
                    confidence=Decimal(str(confidence)),
                    is_validated=validated,
                )

        self.stdout.write(self.style.SUCCESS("Donnees de demonstration chargees."))
