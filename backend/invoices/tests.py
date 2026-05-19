from django.test import TestCase
from django.urls import reverse
from rest_framework import status
from rest_framework.test import APIClient
from decimal import Decimal

from .models import User, Organization, Invoice, InvoiceData

class ModelTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(
            name="Test Org",
            slug="test-org",
            plan=Organization.PLAN_FREE,
            monthly_quota=20
        )

    def test_organization_quota(self):
        self.assertEqual(self.org.quota_remaining(), 20)
        
        Invoice.objects.create(
            organization=self.org,
            file_name="facture1.pdf"
        )
        self.assertEqual(self.org.quota_remaining(), 19)


class APITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        
    def test_register_creates_org_and_owner(self):
        url = reverse('register')
        data = {
            "username": "testowner",
            "email": "owner@test.com",
            "password": "strongpassword123",
            "organization_name": "My Corp"
        }
        response = self.client.post(url, data)
        self.assertEqual(response.status_code, status.HTTP_201_CREATED)
        
        # Verify user and org
        user = User.objects.get(username="testowner")
        self.assertEqual(user.role, User.ROLE_OWNER)
        self.assertIsNotNone(user.organization)
        self.assertEqual(user.organization.name, "My Corp")

    def test_authenticated_access_required(self):
        url = reverse('dashboard')
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_401_UNAUTHORIZED)


class InvoicePermissionsTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        # Setup Org 1 and User 1
        self.org1 = Organization.objects.create(name="Org 1", slug="org-1")
        self.user1 = User.objects.create_user(username="user1", password="pw1", organization=self.org1, role=User.ROLE_OWNER)
        
        # Setup Org 2 and User 2
        self.org2 = Organization.objects.create(name="Org 2", slug="org-2")
        self.user2 = User.objects.create_user(username="user2", password="pw2", organization=self.org2, role=User.ROLE_OWNER)
        
        self.invoice_org1 = Invoice.objects.create(organization=self.org1, file_name="org1.pdf")

    def test_user_can_access_own_invoice(self):
        self.client.force_authenticate(user=self.user1)
        url = reverse('invoice-detail', kwargs={"invoice_id": self.invoice_org1.id})
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_200_OK)
        
    def test_user_cannot_access_other_org_invoice(self):
        self.client.force_authenticate(user=self.user2)
        url = reverse('invoice-detail', kwargs={"invoice_id": self.invoice_org1.id})
        response = self.client.get(url)
        self.assertEqual(response.status_code, status.HTTP_404_NOT_FOUND)

from unittest.mock import patch
from datetime import date
from .services import process_invoice

class PipelineTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Org Pipeline", slug="org-pipe")

    @patch('invoices.services.anthropic_extract')
    @patch('invoices.services.extract_text_from_invoice')
    def test_process_invoice_with_mock_ai(self, mock_ocr, mock_ai):
        mock_ocr.return_value = ('Facture Orange SA\nTTC: 45.00', 'pypdf')
        mock_ai.return_value = {
            'supplier': 'Orange SA', 'invoiceNumber': 'F-2026-001',
            'invoiceDate': date(2026, 5, 1), 'amountHt': Decimal('37.50'),
            'amountTva': Decimal('7.50'), 'amountTtc': Decimal('45.00'),
            'category': 'Telecom', 'confidence': Decimal('0.95')
        }
        invoice = Invoice.objects.create(organization=self.org, file_name='test.pdf')
        process_invoice(invoice)
        
        invoice.refresh_from_db()
        self.assertEqual(invoice.status, Invoice.STATUS_REVIEW)
        self.assertEqual(invoice.supplier, 'Orange SA')
