from rest_framework.permissions import BasePermission
from .models import User


class IsInSameOrganization(BasePermission):
    def has_object_permission(self, request, view, obj):
        user_org_id = getattr(request.user, "organization_id", None)
        obj_org_id = getattr(obj, "organization_id", None)
        return bool(user_org_id and obj_org_id and user_org_id == obj_org_id)


class IsOwner(BasePermission):
    """
    Permet l'accès uniquement aux utilisateurs ayant le rôle OWNER de leur organisation.
    """
    def has_permission(self, request, view):
        return bool(
            request.user and 
            request.user.is_authenticated and 
            request.user.role == User.ROLE_OWNER
        )

class IsMember(BasePermission):
    """
    Permet l'accès à tous les membres de l'organisation (owner et member).
    """
    def has_permission(self, request, view):
        return bool(
            request.user and 
            request.user.is_authenticated and 
            request.user.organization_id is not None
        )
