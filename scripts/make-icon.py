from PIL import Image
import sys

input_path = 'assets/branding/fm-sprachbox-logo-concept.png'
output_path = 'assets/branding/icon.ico'

try:
    img = Image.open(input_path)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    sizes = [16, 32, 48, 64, 128, 256]
    img.save(output_path, format='ICO', sizes=[(s, s) for s in sizes])
    print(f'Created {output_path}')
except Exception as e:
    print(f'Error: {e}', file=sys.stderr)
    sys.exit(1)
