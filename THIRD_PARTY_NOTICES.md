# Third-party notices

## NyaNovel

The reservation rules in this project were adapted from Sakura NAI's client,
which is derived from [NyaNovel](https://github.com/Nya-Foundation/NyaNovel).
The original MIT notice is retained in [LICENSE](LICENSE).

Copyright (c) 2025 Nya Foundation

Sakura Relay's HTTP server, accounting storage and administration interface are
independently implemented. Attribution does not imply upstream endorsement.

## Aaalice_NAI_Launcher

Reservation estimates in src/cost.mjs and src/billing.mjs follow Sakura NAI's lib/nai/cost.ts,
adapted from Aaalice_NAI_Launcher (MIT), including the V5 multiplier, rounding,
Opus discount, allowance state and reference surcharges. Final settlement in
this relay uses observed upstream balance changes, not the reservation estimate.

Source: https://github.com/Aaalice233/Aaalice_NAI_Launcher/blob/main/lib/core/services/anlas_calculator.dart

MIT License

Copyright (c) 2026 NAI Launcher Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
