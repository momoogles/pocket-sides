# OCRデータと第三者ライセンス

## 日本語学習データ

`languages/jpn.traineddata.gz` と `languages/jpn_vert.traineddata.gz` は、Tesseractの公式リポジトリ [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast/tree/87416418657359cb625c412a48b6e1d6d41c29bd) の学習データをgzip圧縮したものです。圧縮を解除した内容は、次のGit blob SHA-1と一致します。

| ファイル | Git blob SHA-1 |
| --- | --- |
| `jpn.traineddata` | `c4178f89991bde90b7fdc647e3e1901868423bd0` |
| `jpn_vert.traineddata` | `43f38defe4b83588876d0d7a6dee928be1b73af0` |

ライセンスは、このディレクトリの `LICENSE`（Apache License 2.0）です。

## Tesseract.jsの第三者コード

`licenses/tesseract.js-7.0.0-THIRD-PARTY-NOTICES.txt` に、Tesseract.js 7.0.0のブラウザ用ワーカーに含まれる第三者コードの著作権表示とライセンス本文を収録しています。対象パッケージは、配布済み `worker.min.js.map` のソース一覧で確認し、バージョンは[配布元のロックファイル](https://github.com/naptha/tesseract.js/blob/v7.0.0/package-lock.json)で照合しています。各ライセンスの出典は本文に記載しています。

`scripts/copy-pdf-assets.mjs` は、このファイルと配布元の付属表示ファイルを公開用ディレクトリへコピーします。Tesseract.jsのバージョンを変更する際は、新しいワーカーのソース一覧と配布元のライセンスを照合し、対応するバージョン名のファイルを追加してください。対応するファイルがない場合はビルドが失敗します。
