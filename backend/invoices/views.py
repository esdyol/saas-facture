from collections import defaultdict
from decimal import Decimal

from django.db.models import Sum
from django.shortcuts import get_object_or_404
from rest_framework import generics, permissions, status
from rest_framework.parsers import FormParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.views import TokenObtainPairView, TokenRefreshView

from .models import Invoice, InvoiceData, Organization, Subscription, User
from .permissions import IsInSameOrganization, IsMember, IsOwner
from .serializers import (
    AppTokenObtainPairSerializer,
    InvoiceSerializer,
    InvoiceValidationSerializer,
    LocalUploadSerializer,
    PresignRequestSerializer,
    RegisterSerializer,
    UserSerializer,
)
from .services import build_public_file_url, enqueue_invoice_processing, generate_presigned_upload, save_local_upload

PLAN_CATALOG = [
    {
        "name": "Free",
        "code": "free",
        "price": "0 EUR",
        "quota": 20,
        "features": ["20 factures/mois", "Dashboard de base", "Validation manuelle"],
    },
    {
        "name": "Pro",
        "code": "pro",
        "price": "29 EUR",
        "quota": 500,
        "features": ["500 factures/mois", "Exports CSV/PDF", "Priorite OCR + IA"],
    },
    {
        "name": "Enterprise",
        "code": "enterprise",
        "price": "99 EUR",
        "quota": None,
        "features": ["Factures illimitees", "Multi-equipes", "Support dedie"],
    },
]


def _invoice_payload(invoice):
    return InvoiceSerializer(invoice).data


def _subscription_payload(org):
    subscription = getattr(org, "subscription", None)
    if not subscription:
        return {"plan": org.plan, "status": "trialing", "currentPeriodEnd": None}
    return {
        "plan": subscription.plan,
        "status": subscription.status,
        "currentPeriodEnd": subscription.current_period_end.isoformat() if subscription.current_period_end else None,
    }


def _summary_payload(org):
    invoices = Invoice.objects.filter(organization=org).select_related("review")
    total_spend = invoices.aggregate(total=Sum("amount_ttc"))["total"] or Decimal("0")
    month_totals = defaultdict(float)
    category_totals = defaultdict(float)
    for invoice in invoices:
        month_key = invoice.invoice_date.strftime("%Y-%m") if invoice.invoice_date else invoice.uploaded_at.strftime("%Y-%m")
        month_totals[month_key] += float(invoice.amount_ttc)
        category_totals[invoice.category or "Non classe"] += float(invoice.amount_ttc)

    return {
        "organization": {
            "name": org.name,
            "slug": org.slug,
            "plan": org.plan,
            "monthlyQuota": org.monthly_quota,
            "quotaUsed": invoices.count(),
            "quotaRemaining": org.quota_remaining(),
        },
        "kpis": {
            "invoiceCount": invoices.count(),
            "validatedCount": invoices.filter(review__is_validated=True).count(),
            "processingCount": invoices.filter(status=Invoice.STATUS_PROCESSING).count(),
            "totalSpend": float(total_spend),
        },
        "monthlySpend": [{"month": month, "total": round(total, 2)} for month, total in sorted(month_totals.items())],
        "categorySpend": [
            {"category": category, "total": round(total, 2)}
            for category, total in sorted(category_totals.items(), key=lambda item: item[1], reverse=True)
        ],
        "latestInvoices": [_invoice_payload(invoice) for invoice in invoices[:5]],
        "subscription": _subscription_payload(org),
    }


class HealthView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response({"status": "ok", "service": "saas-factures-ia"})


class RegisterView(generics.CreateAPIView):
    permission_classes = [permissions.AllowAny]
    serializer_class = RegisterSerializer


class AppTokenObtainPairView(TokenObtainPairView):
    permission_classes = [permissions.AllowAny]
    serializer_class = AppTokenObtainPairSerializer


class AppTokenRefreshView(TokenRefreshView):
    permission_classes = [permissions.AllowAny]


class SessionView(APIView):
    def get(self, request):
        return Response({"user": UserSerializer(request.user).data})


class DashboardView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember]

    def get(self, request):
        return Response(_summary_payload(request.user.organization))


class InvoiceListCreateView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember]

    def get(self, request):
        queryset = Invoice.objects.filter(organization=request.user.organization).select_related("review")
        status_filter = request.query_params.get("status")
        category_filter = request.query_params.get("category")
        search_term = request.query_params.get("search")
        if status_filter:
            queryset = queryset.filter(status=status_filter)
        if category_filter:
            queryset = queryset.filter(category__icontains=category_filter)
        if search_term:
            from django.db.models import Q
            queryset = queryset.filter(
                Q(file_name__icontains=search_term) |
                Q(supplier__icontains=search_term) |
                Q(invoice_number__icontains=search_term) |
                Q(raw_text__icontains=search_term) |
                Q(review__supplier_name__icontains=search_term) |
                Q(review__invoice_number__icontains=search_term)
            ).distinct()
        return Response({"results": [_invoice_payload(invoice) for invoice in queryset[:50]]})

    def post(self, request):
        payload = request.data
        invoice = Invoice.objects.create(
            organization=request.user.organization,
            file_name=payload.get("fileName") or "nouvelle-facture.pdf",
            file_url=payload.get("fileUrl") or "",
            file_s3_key=payload.get("fileKey") or "",
            file_storage=Invoice.STORAGE_S3 if payload.get("fileKey") else Invoice.STORAGE_LOCAL,
            status=Invoice.STATUS_UPLOADED,
        )
        queue_mode = enqueue_invoice_processing(invoice)
        response_payload = _invoice_payload(Invoice.objects.get(pk=invoice.pk))
        response_payload["queueMode"] = queue_mode
        return Response(response_payload, status=status.HTTP_201_CREATED)


class InvoiceDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember, IsInSameOrganization]

    def get_object(self, request, invoice_id):
        invoice = get_object_or_404(Invoice.objects.select_related("review"), pk=invoice_id, organization=request.user.organization)
        self.check_object_permissions(request, invoice)
        return invoice

    def get(self, request, invoice_id):
        return Response(_invoice_payload(self.get_object(request, invoice_id)))


class InvoiceValidateView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember, IsInSameOrganization]

    def patch(self, request, invoice_id):
        invoice = get_object_or_404(Invoice.objects.select_related("review"), pk=invoice_id, organization=request.user.organization)
        self.check_object_permissions(request, invoice)
        serializer = InvoiceValidationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        review, _ = InvoiceData.objects.get_or_create(invoice=invoice)
        review.supplier_name = data["supplier"]
        review.invoice_number = data["invoiceNumber"]
        review.invoice_date = data["invoiceDate"]
        review.amount_ht = data["amountHt"]
        review.amount_tva = data["amountTva"]
        review.amount_ttc = data["amountTtc"]
        review.category = data["category"]
        review.confidence = data.get("confidence", invoice.confidence)
        review.is_validated = True
        review.validated_at = invoice.processed_at
        review.save()

        invoice.status = Invoice.STATUS_DONE
        invoice.supplier = review.supplier_name
        invoice.invoice_number = review.invoice_number
        invoice.invoice_date = review.invoice_date
        invoice.amount_ht = review.amount_ht
        invoice.amount_tva = review.amount_tva
        invoice.amount_ttc = review.amount_ttc
        invoice.category = review.category
        invoice.confidence = review.confidence
        invoice.save()
        return Response(_invoice_payload(invoice))


class InvoiceProcessView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember, IsInSameOrganization]

    def post(self, request, invoice_id):
        invoice = get_object_or_404(Invoice, pk=invoice_id, organization=request.user.organization)
        queue_mode = enqueue_invoice_processing(invoice)
        response_payload = _invoice_payload(Invoice.objects.get(pk=invoice.pk))
        response_payload["queueMode"] = queue_mode
        return Response(response_payload)


class StoragePresignView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember]

    def post(self, request):
        serializer = PresignRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        payload = generate_presigned_upload(
            request.user.organization,
            serializer.validated_data["fileName"],
            serializer.validated_data["contentType"],
        )
        return Response(payload)


class LocalUploadView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember]
    parser_classes = [MultiPartParser, FormParser]

    def post(self, request):
        serializer = LocalUploadSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        uploaded_file = serializer.validated_data["file"]
        invoice = Invoice.objects.create(
            organization=request.user.organization,
            file_name=uploaded_file.name,
            status=Invoice.STATUS_UPLOADED,
            file_storage=Invoice.STORAGE_LOCAL,
        )
        save_local_upload(invoice, uploaded_file)
        invoice.file_url = build_public_file_url(invoice)
        invoice.save(update_fields=["file_url"])
        queue_mode = enqueue_invoice_processing(invoice)
        response_payload = _invoice_payload(Invoice.objects.get(pk=invoice.pk))
        response_payload["queueMode"] = queue_mode
        return Response(response_payload, status=status.HTTP_201_CREATED)


class PlansView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response({"plans": PLAN_CATALOG})


class RoadmapView(APIView):
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response(
            {
                "phases": [
                    {"name": "Phase 1", "focus": "Multi-tenant, auth, admin", "status": "implemented"},
                    {"name": "Phase 2", "focus": "Pipeline OCR + IA", "status": "implemented"},
                    {"name": "Phase 3", "focus": "API upload, validation, rapports", "status": "implemented"},
                    {"name": "Phase 4", "focus": "Interface React", "status": "implemented"},
                    {"name": "Phase 5", "focus": "Stripe + webhooks", "status": "planned"},
                    {"name": "Phase 6", "focus": "Tests, CI/CD, deploiement", "status": "planned"},
                ]
            }
        )
