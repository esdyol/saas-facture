from django.urls import path

from .views import (
    AppTokenObtainPairView,
    AppTokenRefreshView,
    DashboardView,
    HealthView,
    InvoiceDetailView,
    InvoiceListCreateView,
    InvoiceProcessView,
    InvoiceValidateView,
    LocalUploadView,
    PlansView,
    RegisterView,
    RoadmapView,
    SessionView,
    StoragePresignView,
)
from .stripe_views import CreateCheckoutSessionView, StripeWebhookView, CreatePortalSessionView
from .export_views import InvoiceExportView
from .team_views import TeamMemberView

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("auth/register/", RegisterView.as_view(), name="register"),
    path("auth/login/", AppTokenObtainPairView.as_view(), name="token-obtain"),
    path("auth/refresh/", AppTokenRefreshView.as_view(), name="token-refresh"),
    path("session/", SessionView.as_view(), name="session"),
    path("dashboard/", DashboardView.as_view(), name="dashboard"),
    path("invoices/", InvoiceListCreateView.as_view(), name="invoices"),
    path("invoices/export/", InvoiceExportView.as_view(), name="invoices-export"),
    path("invoices/local-upload/", LocalUploadView.as_view(), name="local-upload"),
    path("invoices/<int:invoice_id>/", InvoiceDetailView.as_view(), name="invoice-detail"),
    path("invoices/<int:invoice_id>/process/", InvoiceProcessView.as_view(), name="invoice-process"),
    path("invoices/<int:invoice_id>/validate/", InvoiceValidateView.as_view(), name="invoice-validate"),
    path("storage/presign/", StoragePresignView.as_view(), name="storage-presign"),
    path("plans/", PlansView.as_view(), name="plans"),
    path("roadmap/", RoadmapView.as_view(), name="roadmap"),
    path("team/", TeamMemberView.as_view(), name="team-members"),
    path("stripe/create-checkout-session/", CreateCheckoutSessionView.as_view(), name="stripe-checkout"),
    path("stripe/portal/", CreatePortalSessionView.as_view(), name="stripe-portal"),
    path("stripe/webhook/", StripeWebhookView.as_view(), name="stripe-webhook"),
]
