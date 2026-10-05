document.addEventListener('DOMContentLoaded', () => {
  const fileInput = document.getElementById('crp-file-input');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      const files = Array.from(e.target.files);
      const countDiv = document.getElementById('crp-file-count');
      if (files.length > 0) {
        countDiv.textContent = `Archivos seleccionados: ${files.length}`;
      } else {
        countDiv.textContent = '';
      }
    });
  }
});

async function procesarArchivosCRP() {
  const fileInput = document.getElementById('crp-file-input');
  const btnProcesar = document.getElementById('crp-btn-procesar');
  const statusDiv = document.getElementById('crp-status');
  const errorDiv = document.getElementById('crp-error');

  errorDiv.style.display = 'none';
  errorDiv.textContent = '';

  const files = Array.from(fileInput.files);
  if (files.length === 0) {
    errorDiv.textContent = 'Por favor, selecciona al menos un archivo Excel (.xlsx).';
    errorDiv.style.display = 'block';
    return;
  }

  // Deshabilitar botón y mostrar estado de carga
  btnProcesar.disabled = true;
  btnProcesar.style.opacity = '0.6';
  statusDiv.style.display = 'flex';

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  try {
    const response = await fetch('http://localhost:8000/api/procesar-excel', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.detail || 'Error en el procesamiento del servidor.');
    }

    // Obtener el nombre del archivo desde el encabezado Content-Disposition
    const contentDisposition = response.headers.get('Content-Disposition');
    let filename = 'CRP_procesado.xlsx';
    if (contentDisposition) {
      const match = contentDisposition.match(/filename="?([^"]+)"?/);
      if (match && match[1]) filename = match[1];
    }

    // Descargar automáticamente el archivo retornado
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

  } catch (err) {
    errorDiv.textContent = err.message;
    errorDiv.style.display = 'block';
  } finally {
    btnProcesar.disabled = false;
    btnProcesar.style.opacity = '1';
    statusDiv.style.display = 'none';
  }
}