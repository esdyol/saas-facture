from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.contrib.auth.hashers import make_password

from .models import User
from .permissions import IsOwner
from .serializers import UserSerializer

class TeamMemberView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsOwner]

    def get(self, request):
        # List all members of the organization
        members = User.objects.filter(organization=request.user.organization)
        return Response([UserSerializer(member).data for member in members])

    def post(self, request):
        # Create a new member for the organization
        username = request.data.get("username")
        email = request.data.get("email")
        password = request.data.get("password")
        
        if not username or not email or not password:
            return Response({"error": "Veuillez fournir un nom d'utilisateur, un email et un mot de passe."}, status=status.HTTP_400_BAD_REQUEST)
            
        if User.objects.filter(username=username).exists():
            return Response({"error": "Ce nom d'utilisateur est deja pris."}, status=status.HTTP_400_BAD_REQUEST)
            
        if User.objects.filter(email=email).exists():
            return Response({"error": "Cet email est deja utilise."}, status=status.HTTP_400_BAD_REQUEST)

        # Create the member user
        member = User.objects.create(
            username=username,
            email=email,
            password=make_password(password),
            organization=request.user.organization,
            role=User.ROLE_MEMBER
        )
        
        return Response(UserSerializer(member).data, status=status.HTTP_201_CREATED)
