import os

files = [
    r'C:\Users\joshu\Desktop\Flore website\cca-foundations-exam\index.html',
    r'C:\Users\joshu\Desktop\Flore website\cca-practice-questions\index.html',
    r'C:\Users\joshu\Desktop\Flore website\cca-exam-guide\index.html',
]

# The corrupted separator char is U+0083 (C1 control) + 'A'
bad_sep  = '.bc li+li::before{content:"\u0083A";'
# Replace with proper CSS hex escape \203A  (right angle quotation mark ›)
good_sep = '.bc li+li::before{content:"\\203A";'

for path in files:
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()
    if bad_sep in content:
        content = content.replace(bad_sep, good_sep)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        print('Fixed:', os.path.basename(os.path.dirname(path)))
    else:
        print('Not matched:', os.path.basename(os.path.dirname(path)))
        # Show what's actually there for debugging
        idx = content.find('li+li::before')
        if idx >= 0:
            print('  Found:', repr(content[idx:idx+50]))
