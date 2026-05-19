from django.contrib import admin
from django.contrib.auth.admin import UserAdmin as DjangoUserAdmin

from .models import Invoice, InvoiceData, Organization, ProcessingTask, Subscription, User


@admin.register(Organization)
class OrganizationAdmin(admin.ModelAdmin):
    list_display = ("name", "plan", "monthly_quota", "created_at")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(User)
class UserAdmin(DjangoUserAdmin):
    list_display = ("username", "email", "organization", "role", "is_staff")
    list_filter = ("role", "organization", "is_staff")
    fieldsets = DjangoUserAdmin.fieldsets + (
        ("Tenant", {"fields": ("organization", "role")}),
    )


@admin.register(Invoice)
class InvoiceAdmin(admin.ModelAdmin):
    list_display = ("file_name", "organization", "supplier", "category", "status", "file_storage", "amount_ttc", "uploaded_at")
    list_filter = ("status", "category", "organization", "file_storage")
    search_fields = ("file_name", "supplier", "invoice_number")


@admin.register(InvoiceData)
class InvoiceDataAdmin(admin.ModelAdmin):
    list_display = ("invoice", "supplier_name", "category", "confidence", "is_validated")


@admin.register(Subscription)
class SubscriptionAdmin(admin.ModelAdmin):
    list_display = ("organization", "plan", "status", "current_period_end")


@admin.register(ProcessingTask)
class ProcessingTaskAdmin(admin.ModelAdmin):
    list_display = ("invoice", "started_at", "completed_at")
