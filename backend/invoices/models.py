from django.contrib.auth.models import AbstractUser
from django.db import models
from django.utils import timezone


class Organization(models.Model):
    PLAN_FREE = "free"
    PLAN_PRO = "pro"
    PLAN_ENTERPRISE = "enterprise"
    PLAN_CHOICES = [
        (PLAN_FREE, "Free"),
        (PLAN_PRO, "Pro"),
        (PLAN_ENTERPRISE, "Enterprise"),
    ]

    name = models.CharField(max_length=180)
    slug = models.SlugField(unique=True)
    plan = models.CharField(max_length=20, choices=PLAN_CHOICES, default=PLAN_FREE)
    stripe_customer_id = models.CharField(max_length=120, blank=True)
    monthly_quota = models.PositiveIntegerField(default=20)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return self.name

    def invoice_count_this_month(self):
        now = timezone.now()
        return self.invoices.filter(
            uploaded_at__year=now.year,
            uploaded_at__month=now.month
        ).count()

    def quota_remaining(self):
        return max(self.monthly_quota - self.invoice_count_this_month(), 0)


class User(AbstractUser):
    ROLE_OWNER = "owner"
    ROLE_MEMBER = "member"
    ROLE_CHOICES = [
        (ROLE_OWNER, "Owner"),
        (ROLE_MEMBER, "Member"),
    ]

    organization = models.ForeignKey(
        Organization,
        on_delete=models.CASCADE,
        related_name="users",
        null=True,
        blank=True,
    )
    role = models.CharField(max_length=20, choices=ROLE_CHOICES, default=ROLE_MEMBER)

    def __str__(self):
        return self.username


class Subscription(models.Model):
    STATUS_ACTIVE = "active"
    STATUS_TRIAL = "trialing"
    STATUS_PAST_DUE = "past_due"
    STATUS_CANCELED = "canceled"

    organization = models.OneToOneField(
        Organization,
        on_delete=models.CASCADE,
        related_name="subscription",
    )
    stripe_sub_id = models.CharField(max_length=120, blank=True)
    plan = models.CharField(max_length=20, choices=Organization.PLAN_CHOICES, default=Organization.PLAN_FREE)
    status = models.CharField(max_length=20, default=STATUS_TRIAL)
    current_period_end = models.DateField(null=True, blank=True)

    def __str__(self):
        return f"{self.organization.name} - {self.plan}"


class Invoice(models.Model):
    STORAGE_LOCAL = "local"
    STORAGE_S3 = "s3"
    STORAGE_CHOICES = [
        (STORAGE_LOCAL, "Local"),
        (STORAGE_S3, "S3/R2"),
    ]

    STATUS_UPLOADED = "uploaded"
    STATUS_PROCESSING = "processing"
    STATUS_REVIEW = "review"
    STATUS_DONE = "done"
    STATUS_ERROR = "error"
    STATUS_CHOICES = [
        (STATUS_UPLOADED, "Uploaded"),
        (STATUS_PROCESSING, "Processing"),
        (STATUS_REVIEW, "Review"),
        (STATUS_DONE, "Done"),
        (STATUS_ERROR, "Error"),
    ]

    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name="invoices")
    file_name = models.CharField(max_length=255)
    file_url = models.URLField(blank=True)
    file_s3_key = models.CharField(max_length=255, blank=True)
    local_file = models.FileField(upload_to="invoices/", blank=True, null=True)
    file_storage = models.CharField(max_length=20, choices=STORAGE_CHOICES, default=STORAGE_LOCAL)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default=STATUS_UPLOADED)
    supplier = models.CharField(max_length=180, blank=True)
    invoice_number = models.CharField(max_length=120, blank=True)
    invoice_date = models.DateField(null=True, blank=True)
    amount_ht = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    amount_tva = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    amount_ttc = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    category = models.CharField(max_length=120, blank=True)
    confidence = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    raw_text = models.TextField(blank=True)
    extracted_data = models.JSONField(default=dict, blank=True)
    uploaded_at = models.DateTimeField(auto_now_add=True)
    processed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["-uploaded_at"]

    def __str__(self):
        return f"{self.file_name} ({self.organization.name})"

    def mark_processed(self):
        self.status = self.STATUS_DONE
        self.processed_at = timezone.now()
        self.save(update_fields=["status", "processed_at"])


class InvoiceData(models.Model):
    invoice = models.OneToOneField(Invoice, on_delete=models.CASCADE, related_name="review")
    supplier_name = models.CharField(max_length=180)
    invoice_number = models.CharField(max_length=120)
    invoice_date = models.DateField(null=True, blank=True)
    amount_ht = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    amount_tva = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    amount_ttc = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    category = models.CharField(max_length=120)
    confidence = models.DecimalField(max_digits=5, decimal_places=2, default=0)
    is_validated = models.BooleanField(default=False)
    validated_at = models.DateTimeField(null=True, blank=True)

    def __str__(self):
        return self.invoice.file_name


class ProcessingTask(models.Model):
    invoice = models.OneToOneField(Invoice, on_delete=models.CASCADE, related_name="processing_task")
    celery_task_id = models.CharField(max_length=120, blank=True)
    started_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    error_message = models.TextField(blank=True)

    def __str__(self):
        return f"Task for invoice {self.invoice_id}"
