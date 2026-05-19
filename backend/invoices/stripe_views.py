import stripe
from django.conf import settings
from django.http import HttpResponse
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.views.decorators.csrf import csrf_exempt
from django.utils.decorators import method_decorator
import json
from datetime import datetime

from .models import Organization, Subscription
from .views import PLAN_CATALOG
from .permissions import IsOwner

stripe.api_key = settings.STRIPE_SECRET_KEY

class CreateCheckoutSessionView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOwner]

    def post(self, request):
        plan_code = request.data.get("plan_code")
        plan_details = next((p for p in PLAN_CATALOG if p["code"] == plan_code), None)
        
        if not plan_details:
            return Response({"error": "Plan invalide"}, status=status.HTTP_400_BAD_REQUEST)

        # Basic mapping of plans to prices (in a real app, these would be Stripe Price IDs from settings)
        # We will create a dynamic price for the demo.
        price_in_cents = int(plan_details["price"].split(" ")[0]) * 100
        
        if price_in_cents == 0:
            # Upgrade/Downgrade to free plan logic
            org = request.user.organization
            org.plan = Organization.PLAN_FREE
            org.monthly_quota = 20
            org.save()
            Subscription.objects.update_or_create(
                organization=org,
                defaults={"plan": Organization.PLAN_FREE, "status": Subscription.STATUS_ACTIVE}
            )
            return Response({"success": True, "message": "Plan mis a jour vers Free"})

        try:
            checkout_session = stripe.checkout.Session.create(
                payment_method_types=['card'],
                line_items=[{
                    'price_data': {
                        'currency': 'eur',
                        'product_data': {
                            'name': f'Abonnement SaaS Factures IA - {plan_details["name"]}',
                        },
                        'unit_amount': price_in_cents,
                        'recurring': {'interval': 'month'}
                    },
                    'quantity': 1,
                }],
                metadata={
                    'organization_id': request.user.organization.id,
                    'plan_code': plan_code,
                },
                mode='subscription',
                success_url=settings.FRONTEND_URL + '/?stripe=success',
                cancel_url=settings.FRONTEND_URL + '/?stripe=cancel',
            )
            return Response({"url": checkout_session.url})
        except Exception as e:
            return Response({"error": str(e)}, status=status.HTTP_500_INTERNAL_SERVER_ERROR)


@method_decorator(csrf_exempt, name='dispatch')
class StripeWebhookView(APIView):
    permission_classes = [permissions.AllowAny]

    def post(self, request):
        if not settings.STRIPE_WEBHOOK_SECRET:
            return HttpResponse(status=400)

        payload = request.body
        sig_header = request.META.get('HTTP_STRIPE_SIGNATURE')
        
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, settings.STRIPE_WEBHOOK_SECRET
            )
        except (ValueError, stripe.error.SignatureVerificationError):
            return HttpResponse(status=400)

        # Handle the event
        if event['type'] == 'checkout.session.completed':
            session = event['data']['object']
            org_id = session.get('metadata', {}).get('organization_id')
            plan_code = session.get('metadata', {}).get('plan_code')
            customer_id = session.get('customer')
            
            if org_id and plan_code:
                try:
                    org = Organization.objects.get(id=org_id)
                    org.plan = plan_code
                    if customer_id:
                        org.stripe_customer_id = customer_id
                    # Update quota
                    plan_details = next((p for p in PLAN_CATALOG if p["code"] == plan_code), None)
                    if plan_details:
                        org.monthly_quota = plan_details["quota"] if plan_details["quota"] is not None else 999999
                    org.save()
                    
                    Subscription.objects.update_or_create(
                        organization=org,
                        defaults={
                            "stripe_sub_id": session.get('subscription', ''),
                            "plan": plan_code,
                            "status": Subscription.STATUS_ACTIVE,
                        }
                    )
                except Organization.DoesNotExist:
                    pass

        return HttpResponse(status=200)

class CreatePortalSessionView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOwner]

    def post(self, request):
        org = request.user.organization
        if not org.stripe_customer_id:
            return Response({'error': 'Pas de client Stripe associe a cette organisation.'}, status=400)
            
        try:
            session = stripe.billing_portal.Session.create(
                customer=org.stripe_customer_id,
                return_url=settings.FRONTEND_URL + '/dashboard',
            )
            return Response({'url': session.url})
        except Exception as e:
            return Response({'error': str(e)}, status=500)
