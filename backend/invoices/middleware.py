from django.conf import settings
from django.http import HttpResponse


class SimpleCorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.method == "OPTIONS":
            response = HttpResponse(status=200)
        else:
            response = self.get_response(request)

        origin = request.headers.get("Origin")
        allowed = getattr(settings, "CORS_ALLOWED_ORIGINS", [])
        if origin and origin in allowed:
            response["Access-Control-Allow-Origin"] = origin
        elif allowed:
            response["Access-Control-Allow-Origin"] = allowed[0]

        response["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
        response["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS"
        return response
