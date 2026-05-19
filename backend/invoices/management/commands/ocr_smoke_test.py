from pathlib import Path

from django.core.management.base import BaseCommand, CommandError

from invoices.services import extract_text_from_image, extract_text_from_pdf


class Command(BaseCommand):
    help = "Teste rapidement l'OCR sur un fichier local."

    def add_arguments(self, parser):
        parser.add_argument("file_path", type=str)

    def handle(self, *args, **options):
        file_path = Path(options["file_path"])
        if not file_path.exists():
            raise CommandError(f"Fichier introuvable: {file_path}")

        raw = file_path.read_bytes()
        suffix = file_path.suffix.lower()
        if suffix == ".pdf":
            text, engine = extract_text_from_pdf(raw)
        else:
            text, engine = extract_text_from_image(raw)

        self.stdout.write(self.style.SUCCESS(f"engine={engine}"))
        self.stdout.write(text[:4000] or "[aucun texte]")
