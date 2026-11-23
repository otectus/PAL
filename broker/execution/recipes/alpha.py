import glob
from PIL import Image
paths = sorted(glob.glob('/work/input/*'))
images = [Image.open(p).convert('RGBA') for p in paths]
for p, im in zip(paths, images):
    a = im.getchannel('A'); opaque = sum(1 for v in a.getdata() if v == 255)
    print(p.split('/')[-1], im.size, f'{100*opaque/(im.width*im.height):.1f}% opaque')
cell = 256
sheet = Image.new('RGBA', (cell * min(4, len(images)), cell * ((len(images) + 3) // 4)), 'white')
for i, im in enumerate(images):
    im.thumbnail((cell, cell)); sheet.paste(im, ((i % 4) * cell, (i // 4) * cell), im)
sheet.save('/work/output/contact-sheet.png')
