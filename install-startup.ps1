# Install PM2 auto-start on Windows logon
$action = New-ScheduledTaskAction -Execute "W:/Games/nodejs/node.exe" -Argument "C:/Users/Administrator/AppData/Roaming/npm/node_modules/pm2/bin/pm2 resurrect"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName "HanakoEmailMonitor" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "Scheduled task created: HanakoEmailMonitor"
