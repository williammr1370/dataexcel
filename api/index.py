from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import openpyxl
from openpyxl.styles import PatternFill
import io
from typing import List

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/api/procesar-excel")
async def procesar_excel(files: List[UploadFile] = File(...)):
    if not files:
        raise HTTPException(status_code=400, detail="No se enviaron archivos.")

    wb_destino = openpyxl.Workbook()
    wb_destino.remove(wb_destino.active)  # Eliminar hoja inicial

    fill_verde = PatternFill(start_color="D9EAD3", end_color="D9EAD3", fill_type="solid")

    for file in files:
        try:
            contenido = await file.read()
            # Cargar en modo rápido
            wb_origen = openpyxl.load_workbook(io.BytesIO(contenido), data_only=True)

            nombre_hoja = file.filename.replace(".xlsx", "").replace(".xls", "")[:30]
            ws_destino = wb_destino.create_sheet(title=nombre_hoja)
            ws_origen = wb_origen.active

            for row in ws_origen.iter_rows(values_only=False):
                for cell in row:
                    if cell.value is not None:
                        nueva_celda = ws_destino.cell(row=cell.row, column=cell.column, value=cell.value)
                        
                        # Conservar hipervínculos si existen
                        if cell.hyperlink:
                            nueva_celda.hyperlink = cell.hyperlink.target

                        # Formato condicional
                        if isinstance(cell.value, str):
                            val_upper = cell.value.upper()
                            if "OK" in val_upper or "COMPLETADO" in val_upper:
                                nueva_celda.fill = fill_verde

        except Exception as e:
            raise HTTPException(
                status_code=500, 
                detail=f"Error al procesar {file.filename}: {str(e)}"
            )

    stream = io.BytesIO()
    wb_destino.save(stream)
    stream.seek(0)

    headers = {
        'Content-Disposition': 'attachment; filename="CRP_Unificado_Procesado.xlsx"'
    }

    return StreamingResponse(
        stream,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers
    )