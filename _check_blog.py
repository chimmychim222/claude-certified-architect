import glob, os

for path in glob.glob(r'C:\Users\joshu\Desktop\Flore website\blog\**\index.html', recursive=True):
    with open(path, 'rb') as f:
        content = f.read()
    idx = content.find(b'li+li::before')
    if idx >= 0:
        folder = os.path.basename(os.path.dirname(path))
        print(folder, '->', repr(content[idx:idx+55]))
