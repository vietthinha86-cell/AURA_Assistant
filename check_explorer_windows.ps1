$app = New-Object -ComObject Shell.Application
foreach ($w in $app.Windows()) {
    try {
        Write-Host "Name: $($w.LocationName) | URL: $($w.LocationURL)"
    } catch {}
}

