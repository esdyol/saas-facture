import csv
import io
from django.http import HttpResponse
from rest_framework import permissions
from rest_framework.views import APIView
from reportlab.lib.pagesizes import letter
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

from .models import Invoice
from .permissions import IsMember

class InvoiceExportView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsMember]

    def get(self, request):
        format_type = request.query_params.get("format", "csv").lower()
        
        # Get invoices for the organization
        invoices = Invoice.objects.filter(
            organization=request.user.organization,
            status=Invoice.STATUS_DONE
        ).select_related("review").order_by("-invoice_date", "-uploaded_at")

        if format_type == "pdf":
            return self._export_pdf(invoices, request.user.organization.name)
        
        return self._export_csv(invoices)

    def _export_csv(self, invoices):
        response = HttpResponse(content_type='text/csv')
        response['Content-Disposition'] = 'attachment; filename="factures_export.csv"'
        
        writer = csv.writer(response)
        writer.writerow([
            'Fichier', 'Statut', 'Fournisseur', 'Numero Facture', 'Date', 
            'Montant HT', 'Montant TVA', 'Montant TTC', 'Categorie'
        ])
        
        for inv in invoices:
            review = getattr(inv, "review", None)
            writer.writerow([
                inv.file_name,
                inv.get_status_display(),
                review.supplier_name if review else inv.supplier,
                review.invoice_number if review else inv.invoice_number,
                review.invoice_date.isoformat() if review and review.invoice_date else (inv.invoice_date.isoformat() if inv.invoice_date else ""),
                float(review.amount_ht) if review else float(inv.amount_ht),
                float(review.amount_tva) if review else float(inv.amount_tva),
                float(review.amount_ttc) if review else float(inv.amount_ttc),
                review.category if review else inv.category
            ])
            
        return response

    def _export_pdf(self, invoices, org_name):
        buffer = io.BytesIO()
        doc = SimpleDocTemplate(buffer, pagesize=letter, rightMargin=30, leftMargin=30, topMargin=30, bottomMargin=18)
        elements = []
        styles = getSampleStyleSheet()
        
        # Title
        elements.append(Paragraph(f"Rapport de Facturation - {org_name}", styles['Title']))
        elements.append(Spacer(1, 12))
        
        # Table data
        data = [['Fournisseur', 'Numero', 'Date', 'TTC', 'Categorie']]
        total_ttc = 0
        
        for inv in invoices:
            review = getattr(inv, "review", None)
            supplier = review.supplier_name if review else inv.supplier
            number = review.invoice_number if review else inv.invoice_number
            date_val = review.invoice_date.isoformat() if review and review.invoice_date else (inv.invoice_date.isoformat() if inv.invoice_date else "N/A")
            ttc = float(review.amount_ttc) if review else float(inv.amount_ttc)
            category = review.category if review else inv.category
            
            total_ttc += ttc
            
            data.append([
                Paragraph(supplier or "N/A", styles['Normal']),
                number or "N/A",
                date_val,
                f"{ttc:.2f} EUR",
                category or "N/A"
            ])
            
        # Append Total
        data.append(['', '', 'Total:', f"{total_ttc:.2f} EUR", ''])

        # Create table
        table = Table(data, colWidths=[160, 100, 80, 80, 100])
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor("#0f766e")),
            ('TEXTCOLOR', (0, 0), (-1, 0), colors.whitesmoke),
            ('ALIGN', (0, 0), (-1, -1), 'LEFT'),
            ('ALIGN', (3, 0), (3, -1), 'RIGHT'), # align amounts to right
            ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
            ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
            ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor("#f8fafc")),
            ('GRID', (0,0), (-1,-1), 1, colors.lightgrey),
            ('FONTNAME', (0, -1), (-1, -1), 'Helvetica-Bold'), # bold total row
            ('BACKGROUND', (0, -1), (-1, -1), colors.HexColor("#e2e8f0")), # grey bg for total row
        ]))
        
        elements.append(table)
        doc.build(elements)
        
        pdf = buffer.getvalue()
        buffer.close()
        
        response = HttpResponse(content_type='application/pdf')
        response['Content-Disposition'] = 'attachment; filename="rapport_factures.pdf"'
        response.write(pdf)
        return response
