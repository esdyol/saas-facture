from rest_framework import serializers
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer

from .models import Invoice, InvoiceData, Organization, Subscription, User


class OrganizationSerializer(serializers.ModelSerializer):
    quotaRemaining = serializers.SerializerMethodField()

    class Meta:
        model = Organization
        fields = ("id", "name", "slug", "plan", "monthly_quota", "quotaRemaining")

    def get_quotaRemaining(self, obj):
        return obj.quota_remaining()


class UserSerializer(serializers.ModelSerializer):
    organization = OrganizationSerializer(read_only=True)

    class Meta:
        model = User
        fields = ("id", "username", "email", "role", "organization")


class RegisterSerializer(serializers.ModelSerializer):
    organization_name = serializers.CharField(write_only=True)
    password = serializers.CharField(write_only=True, min_length=8)

    class Meta:
        model = User
        fields = ("username", "email", "password", "organization_name")

    def create(self, validated_data):
        organization_name = validated_data.pop("organization_name")
        org = Organization.objects.create(
            name=organization_name,
            slug=organization_name.lower().replace(" ", "-"),
            plan=Organization.PLAN_FREE,
            monthly_quota=20,
        )
        Subscription.objects.create(organization=org, plan=Organization.PLAN_FREE, status=Subscription.STATUS_TRIAL)
        user = User.objects.create_user(
            username=validated_data["username"],
            email=validated_data["email"],
            password=validated_data["password"],
            organization=org,
            role=User.ROLE_OWNER,
        )
        return user


class InvoiceSerializer(serializers.ModelSerializer):
    isValidated = serializers.SerializerMethodField()
    invoiceDate = serializers.SerializerMethodField()
    amountHt = serializers.SerializerMethodField()
    amountTva = serializers.SerializerMethodField()
    amountTtc = serializers.SerializerMethodField()
    invoiceNumber = serializers.SerializerMethodField()
    fileName = serializers.CharField(source="file_name")
    fileUrl = serializers.CharField(source="file_url")

    class Meta:
        model = Invoice
        fields = (
            "id",
            "fileName",
            "fileUrl",
            "status",
            "supplier",
            "invoiceNumber",
            "invoiceDate",
            "amountHt",
            "amountTva",
            "amountTtc",
            "category",
            "confidence",
            "isValidated",
            "uploaded_at",
            "processed_at",
            "raw_text",
            "extracted_data",
            "file_storage",
            "file_s3_key",
        )

    def get_isValidated(self, obj):
        return bool(getattr(obj.review, "is_validated", False)) if hasattr(obj, "review") else False

    def get_invoiceDate(self, obj):
        review = getattr(obj, "review", None)
        invoice_date = review.invoice_date if review and review.invoice_date else obj.invoice_date
        return invoice_date.isoformat() if invoice_date else None

    def _decimal_value(self, obj, attr):
        review = getattr(obj, "review", None)
        value = getattr(review, attr) if review else getattr(obj, attr)
        return float(value)

    def get_amountHt(self, obj):
        return self._decimal_value(obj, "amount_ht")

    def get_amountTva(self, obj):
        return self._decimal_value(obj, "amount_tva")

    def get_amountTtc(self, obj):
        return self._decimal_value(obj, "amount_ttc")

    def get_invoiceNumber(self, obj):
        review = getattr(obj, "review", None)
        return review.invoice_number if review else obj.invoice_number


class InvoiceValidationSerializer(serializers.Serializer):
    supplier = serializers.CharField(max_length=180)
    invoiceNumber = serializers.CharField(max_length=120)
    invoiceDate = serializers.DateField()
    amountHt = serializers.DecimalField(max_digits=10, decimal_places=2)
    amountTva = serializers.DecimalField(max_digits=10, decimal_places=2)
    amountTtc = serializers.DecimalField(max_digits=10, decimal_places=2)
    category = serializers.CharField(max_length=120)
    confidence = serializers.DecimalField(max_digits=5, decimal_places=2, required=False)


class LocalUploadSerializer(serializers.Serializer):
    file = serializers.FileField()


class PresignRequestSerializer(serializers.Serializer):
    fileName = serializers.CharField(max_length=255)
    contentType = serializers.CharField(max_length=120)


class ProcessInvoiceSerializer(serializers.Serializer):
    invoice_id = serializers.IntegerField(required=False)


class AppTokenObtainPairSerializer(TokenObtainPairSerializer):
    @classmethod
    def get_token(cls, user):
        token = super().get_token(user)
        token["username"] = user.username
        token["organization_id"] = user.organization_id
        token["role"] = user.role
        return token

    def validate(self, attrs):
        data = super().validate(attrs)
        data["user"] = UserSerializer(self.user).data
        return data
