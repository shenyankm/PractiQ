"""Format-specific public graphs sharing the document parsing workflow."""

from practiq_ai.graphs.document import build_document_graph

text_csv_parser = build_document_graph(
    name="text_csv_parser", source_types=("text", "csv")
)
pdf_parser = build_document_graph(name="pdf_parser", source_types=("pdf",))
docx_parser = build_document_graph(name="docx_parser", source_types=("docx",))
excel_parser = build_document_graph(name="excel_parser", source_types=("xlsx",))
