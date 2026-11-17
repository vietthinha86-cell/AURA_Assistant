/**
 * ============================================================================
 * MODULE E: ĐỊNH NGHĨA CÔNG CỤ (TOOL DEFINITIONS) & RÀNG BUỘC AN TOÀN
 * - Định nghĩa các tool ở định dạng trung lập (name, description, parameters, risk)
 * - Chuyển đổi linh hoạt sang định dạng Function Calling của Gemini & Claude
 * - Phân loại rủi ro (risk: 'safe' | 'high_risk') phục vụ cơ chế hỏi xác nhận
 * - Bộ lọc từ chối các hành động nguy hiểm chưa được hỗ trợ ở Bước 5:
 *   (xoá file, ghi/di chuyển file, gửi tin nhắn/email, chạy lệnh tuỳ ý, thanh toán, cài app)
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const TRUSTED_DOMAINS = Object.freeze([
  'youtube.com',
  'www.youtube.com',
  'google.com',
  'www.google.com',
  'google.com.vn',
  'www.google.com.vn',
  'netflix.com',
  'www.netflix.com',
  'spotify.com',
  'www.spotify.com',
  'facebook.com',
  'www.facebook.com',
  'github.com',
  'www.github.com',
  'wikipedia.org',
  'en.wikipedia.org',
  'vi.wikipedia.org',
  'chatgpt.com',
  'claude.ai'
]);

const UNSUPPORTED_ACTIONS_NOTICE = Object.freeze({
  delete_file: 'Tính năng xoá file hiện chưa được hỗ trợ vì lý do an toàn dữ liệu.',
  write_file: 'Tính năng tự động ghi hoặc sửa file trên hệ thống chưa được hỗ trợ ở bước này.',
  move_file: 'Tính năng di chuyển file chưa được hỗ trợ ở bước này.',
  send_message: 'Tính năng gửi tin nhắn cá nhân chưa được hỗ trợ.',
  send_email: 'Tính năng gửi email chưa được hỗ trợ.',
  run_command: 'Tính năng thực thi lệnh hệ thống tuỳ ý (run_command) bị khoá để bảo đảm an toàn.',
  make_payment: 'Tính năng thanh toán tài chính không được phép trên Aura.',
  install_software: 'Tính năng tự động tải và cài đặt phần mềm chưa được hỗ trợ.'
});

const NEUTRAL_TOOLS = Object.freeze([
  {
    name: 'open_app',
    description: 'Mở một ứng dụng trong danh sách cho phép (allowed_apps.json) như notepad, calculator, chrome, edge, explorer, word, excel, vscode. LƯU Ý QUAN TRỌNG: TUYỆT ĐỐI KHÔNG dùng tool này để mở thư mục hoặc folder! Khi mở thư mục, BẮT BUỘC dùng tool open_folder(path).',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tên ứng dụng muốn mở (ví dụ: notepad, calculator, chrome, edge, explorer, word, excel, vscode)'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'close_app',
    description: 'Đóng một ứng dụng đang chạy trong danh sách cho phép (allowed_apps.json). Thao tác này LUÔN hỏi xác nhận người dùng trước khi đóng.',
    risk: 'high_risk',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Tên ứng dụng muốn đóng (ví dụ: notepad, calculator, chrome, edge, word, excel, vscode)'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'open_url',
    description: 'Mở một liên kết web (chỉ chấp nhận http:// hoặc https://) bằng trình duyệt mặc định. Tên miền tin cậy (như youtube.com, google.com, netflix.com, spotify.com, facebook.com, github.com) sẽ mở ngay, tên miền lạ phải hỏi xác nhận.',
    risk: 'dynamic', // Tự đánh giá theo tên miền
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'Địa chỉ URL đầy đủ bắt đầu bằng http:// hoặc https://'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'open_live_stream',
    description: 'Tìm và mở ĐÚNG buổi livestream đang phát trực tiếp của các giải đấu thể thao điện tử/game (như Liên Minh Huyền Thoại, LCK, VCS, LPL, CKTG, Worlds, MSI, hoặc theo tên đội như T1, GAM, GEN...) từ danh sách kênh chính thức (live_channels.json). BẮT BUỘC DÙNG tool này cho mọi câu có từ "trực tiếp", "live", "đang phát" đi kèm tên giải đấu/game/đội tuyển. Tự động kiểm tra và xác minh trạng thái phát sóng trực tiếp (LIVE), ưu tiên kênh tiếng Việt trước rồi tới tiếng Anh, không bao giờ mở bản phát lại hay clip tổng hợp giả mạo.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Tên giải đấu, game hoặc đội tuyển cần xem livestream trực tiếp (ví dụ: "Liên Minh Huyền Thoại", "LCK", "VCS", "LPL", "CKTG", "Worlds", "T1", "GAM")'
        }
      },
      required: ['topic']
    }
  },
  {
    name: 'open_youtube_video',
    description: 'Tìm kiếm và mở PHÁT video YouTube phù hợp nhất (dạng https://www.youtube.com/watch?v=...) trong một bước duy nhất bằng trình duyệt. Dùng cho mọi yêu cầu bài hát, clip, phim thông thường như "mở YouTube bài X", "mở clip X", "xem X trên YouTube", "phát X", "bật nhạc X". Tự động lấy video chuẩn nhất, bỏ qua quảng cáo, Shorts, livestream, danh sách phát và mở phát ngay mà không cần dùng chụp màn hình hay thao tác chuột. LƯU Ý: KHÔNG dùng tool này cho các yêu cầu xem livestream giải đấu eSports/game (hãy dùng open_live_stream).',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Tên bài hát, clip, phim hoặc nội dung muốn mở xem/phát ngay trên YouTube (ví dụ: Trao cho anh, Me at the zoo, phim hài)'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'open_youtube_search',
    description: 'Mở trang danh sách kết quả tìm kiếm trên YouTube (https://www.youtube.com/results?search_query=...). CHỈ dùng khi người dùng nói rõ là chỉ muốn "tìm kiếm danh sách trên YouTube" mà không yêu cầu phát hoặc mở video cụ thể.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Từ khoá muốn tìm kiếm trên YouTube'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'open_folder',
    description: 'Mở cửa sổ File Explorer tại đúng thư mục được chỉ định (bằng spawn("explorer.exe", [path])). BẮT BUỘC dùng tool này khi người dùng yêu cầu "mở thư mục X", "mở folder X", "vào thư mục X". Chỉ cho mở thư mục nằm trong danh sách cho phép (allowed_folders.json), nếu ngoài danh sách thì hỏi xác nhận. TUYỆT ĐỐI KHÔNG dùng open_app("explorer") để mở thư mục.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn tuyệt đối hoặc chính xác tới thư mục cần mở (ví dụ: D:\\ảnh\\SWT301\\test topic, D:\\ảnh\\SWT301\\labs, D:\\AURA_Assistant)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'open_file',
    description: 'Mở một file cụ thể bằng ứng dụng mặc định của hệ thống Windows (ví dụ: mở file ảnh, file tài liệu, README...). Chỉ cho mở file nằm trong thư mục được cấp phép (allowed_folders.json).',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn file cần mở (ví dụ: D:\\AURA_Assistant\\README.md, D:\\ảnh\\SWT301\\labs\\lab1.docx)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'list_directory',
    description: 'Liệt kê tất cả các file và thư mục con trực tiếp bên trong một thư mục được cấp phép (allowed_folders.json). Trả về danh sách tên, phân loại file/thư mục, dung lượng và tổng số lượng. Bắt buộc dùng tool này khi người dùng yêu cầu "liệt kê thư mục X", "xem trong thư mục X có gì", "danh sách file trong X".',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn thư mục cần liệt kê (ví dụ: D:\\AURA_Assistant, D:\\ảnh\\SWT301, C:\\Users\\ADMIN\\Documents)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'file_search',
    description: 'Tìm kiếm file và thư mục đệ quy theo tên trong các thư mục được cấp phép (allowed_folders.json). Hỗ trợ tìm kiếm theo loại (file, folder hoặc any), không phân biệt hoa thường và không dấu tiếng Việt. Đệ quy tối thiểu 5 cấp.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Tên file hoặc thư mục cần tìm (ví dụ: SWT301, README, package.json, *). Hỗ trợ tìm kiếm không dấu.'
        },
        folder: {
          type: 'string',
          description: 'Đường dẫn thư mục hoặc ổ đĩa muốn tìm kiếm (ví dụ: D:\\, ổ D, D:\\ảnh, D:\\AURA_Assistant). Mặc định là thư mục dự án Aura.'
        },
        type: {
          type: 'string',
          enum: ['file', 'folder', 'any'],
          description: 'Loại mục cần tìm: "file" (chỉ tìm file), "folder" (chỉ tìm thư mục), hoặc "any" (tìm cả hai). Mặc định là "any".'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'list_test_topics',
    description: 'Liệt kê danh sách tất cả các bài test / topic kiểm thử môn SWT301 có sẵn trong file cấu hình test_topics.json cùng mô tả chi tiết.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'run_test',
    description: 'Chạy một bài test SWT301 được khai báo cố định trong test_topics.json (ví dụ: topic 1, topic 2, tất cả topic, all, lab 3, test lỗi). BẮT BUỘC hỏi xác nhận trước khi chạy. Lệnh và tham số được cố định an toàn, không chạy lệnh shell tự do bên ngoài.',
    risk: 'high_risk',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'Tên topic, ID hoặc từ khóa nhận diện bài test (ví dụ: topic 1, topic 2, tất cả, all, lab 3, test lỗi)'
        }
      },
      required: ['topic']
    }
  },
  {
    name: 'get_latest_test_report',
    description: 'Đọc lại báo cáo kiểm thử gần nhất đã chạy từ thư mục reports/ (số lượng test case đạt, lỗi, thời gian và trích log chi tiết).',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'ID hoặc tên topic muốn xem báo cáo (để trống nếu muốn xem báo cáo mới nhất của toàn hệ thống)'
        }
      }
    }
  },
  {
    name: 'find_project',
    description: 'Tìm kiếm thư mục dự án trên máy tính theo tên dự án hoặc đường dẫn (bỏ qua thư mục hệ thống Windows, node_modules, $RECYCLE.BIN). Nếu có nhiều kết quả, danh sách sẽ được liệt kê để người dùng chọn.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Tên dự án hoặc đường dẫn (ví dụ: "AURA_Assistant", "test topic", "SWT301", "D:\\ảnh\\SWT301\\test topic")'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'scan_project',
    description: 'Nhận diện loại dự án và tự đoán lệnh test/build/run dựa trên cấu trúc các file cấu hình (package.json, pom.xml, requirements.txt, playwright.config, scripts, .csproj...). Kết quả được lưu vào projects_cache.json để lần sau tái sử dụng.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn thư mục dự án cần phân tích nhận diện'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'run_live_test',
    description: 'TRÌNH KIỂM THỬ THỰC TẾ VẠN NĂNG (UNIVERSAL LIVE TESTER): Tự động kiểm thử bất kỳ đối tượng nào (trang web URL, file HTML, REST API, thư mục dự án mã nguồn, hoặc ứng dụng phần mềm Desktop như Calculator). Aura tự phân loại target, chạy Playwright có giao diện (headed) cho web/HTML để người dùng nhìn thấy thao tác thật, gửi request thật cho REST API, chạy test thật cho dự án, hoặc dùng computer-use cho desktop app. Tự động sinh test case từ thực tế (hợp lệ, biên, rỗng, ký tự đặc biệt, XSS/SQLi an toàn, responsive), chụp ảnh màn hình bằng chứng, lưu báo cáo HTML/Markdown vào reports/ và nói ngắn từng bước. Nếu người dùng yêu cầu "test và sửa", Aura sẽ tự động sao lưu và chạy vòng lặp sửa lỗi tối đa 8 vòng.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'URL website, đường dẫn file/thư mục, hoặc tên ứng dụng cần kiểm thử (ví dụ: "https://example.com", "https://jsonplaceholder.typicode.com/posts", "D:\\ảnh\\SWT301\\test topic\\Topic_03_Web_E2E_Testing\\sample_code\\DateTimeChecker_App.html", "D:\\ảnh\\SWT301\\test topic", "Calculator")'
        },
        goal: {
          type: 'string',
          description: 'Yêu cầu kiểm thử cụ thể (ví dụ: "test toàn bộ", "test chức năng đăng nhập", "test phép tính 12 x 3 = 36", "test và sửa nếu có lỗi")'
        },
        autoFix: {
          type: 'boolean',
          description: 'Bật vòng lặp tự động sửa lỗi và test lại (tối đa 8 vòng) nếu phát hiện lỗi và người dùng yêu cầu "test và sửa"'
        }
      },
      required: ['target']
    }
  },
  {
    name: 'run_in_project',
    description: 'Chạy một lệnh kiểm thử (test), biên dịch (build), khởi chạy (run) hoặc cài đặt gói (install) bên trong thư mục dự án bằng tiến trình con spawn. Có giới hạn timeout (mặc định 5 phút), đọc kết quả thực tế (exit code, số ca đạt/lỗi, danh sách test lỗi) và lưu báo cáo vào thư mục reports/.',
    risk: 'neutral',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn thư mục dự án nơi thực thi lệnh (nếu để trống sẽ dùng dự án đã quét gần nhất)'
        },
        command: {
          type: 'string',
          description: 'Lệnh cần chạy (ví dụ: "npm test", "node scripts/run_all_tests.js", "npm run build", "npm start", "dotnet test", "npm install")'
        },
        timeoutSec: {
          type: 'number',
          description: 'Thời gian chờ tối đa bằng giây (mặc định 300 giây = 5 phút)'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Đọc nội dung văn bản của một file nằm trong thư mục được phép hoặc trong dự án. Giới hạn dung lượng tối đa 200KB.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn file văn bản cần đọc'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'edit_file',
    description: 'Sửa nội dung file mã nguồn trong dự án bằng cách thay thế đoạn chuỗi target bằng replacement. Trước lần sửa đầu tiên trong phiên, Aura tự động tạo nhánh Git aura/<time> hoặc sao lưu thư mục vào D:\\Aura_Backups mà không cần hỏi lại. Tự động lưu diff vào thư mục reports/.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn file cần sửa'
        },
        target: {
          type: 'string',
          description: 'Đoạn mã / chuỗi ký tự chính xác cần thay thế'
        },
        replacement: {
          type: 'string',
          description: 'Đoạn mã mới sẽ thay thế vào'
        }
      },
      required: ['path', 'target', 'replacement']
    }
  },
  {
    name: 'create_file',
    description: 'Tạo một file mới trong thư mục dự án (tự động sao lưu dự án trước lần sửa đầu tiên trong phiên).',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn file mới cần tạo'
        },
        content: {
          type: 'string',
          description: 'Nội dung văn bản ghi vào file'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'undo_last_change',
    description: 'Hoàn tác thay đổi mã nguồn vừa sửa bằng cách khôi phục qua nhánh Git hoặc từ bản sao lưu gần nhất trong D:\\Aura_Backups.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Đường dẫn dự án hoặc file cần hoàn tác'
        }
      }
    }
  },
  {
    name: 'clipboard_read',
    description: 'Đọc nội dung văn bản hiện tại đang có trong bộ nhớ tạm (clipboard) của máy tính.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'clipboard_write',
    description: 'Ghi một đoạn văn bản mới vào bộ nhớ tạm (clipboard) của máy tính. Thao tác này sẽ hỏi xác nhận để tránh đè mất dữ liệu quan trọng.',
    risk: 'high_risk',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Đoạn văn bản cần lưu vào clipboard'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'set_reminder',
    description: 'Đặt lời nhắc hẹn giờ sau số phút nhất định. Khi đến giờ, Aura sẽ tự động đọc to câu nhắc và hiện thông báo.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        minutes: {
          type: 'number',
          description: 'Số phút đếm ngược (ví dụ: 1, 5, 10, 60)'
        },
        message: {
          type: 'string',
          description: 'Nội dung nhắc việc khi đến giờ'
        }
      },
      required: ['minutes', 'message']
    }
  },
  {
    name: 'get_preferences',
    description: 'Đọc các sở thích đã lưu của người dùng từ preferences.json (thể loại phim, kênh yêu thích, gu nhạc...). Dùng khi người dùng yêu cầu "mở phim tôi thích", "bật nhạc tôi thích".',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'save_preference',
    description: 'Lưu hoặc cập nhật sở thích người dùng vào file preferences.json (ví dụ: key="favorite_movie_genre", value="phim hài").',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Tên sở thích (ví dụ: favorite_movie_genre, favorite_music, favorite_channels)'
        },
        value: {
          type: 'string',
          description: 'Giá trị sở thích mà người dùng thích'
        }
      },
      required: ['key', 'value']
    }
  },
  // ==========================================================================
  // BƯỚC 6: CÔNG CỤ COMPUTER-USE (NHÌN MÀN HÌNH & ĐIỀU KHIỂN CHUỘT / PHÍM)
  // ==========================================================================
  {
    name: 'take_screenshot',
    description: 'Chụp ảnh màn hình máy tính hiện tại (thu nhỏ <= 1280px trong RAM, không lưu ổ đĩa) để gửi cho hàm vision() quan sát giao diện.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'mouse_click',
    description: 'Di chuyển và bấm chuột trái/phải tại toạ độ (x, y) trên ảnh chụp màn hình thu nhỏ.',
    risk: 'dynamic',
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Toạ độ X trên ảnh màn hình thu nhỏ'
        },
        y: {
          type: 'number',
          description: 'Toạ độ Y trên ảnh màn hình thu nhỏ'
        },
        button: {
          type: 'string',
          description: 'Nút chuột: left (mặc định), right hoặc middle'
        },
        description: {
          type: 'string',
          description: 'Mô tả ngắn gọn thành phần hoặc nút Aura sắp bấm vào (ví dụ: nút Tìm kiếm, video đầu tiên)'
        }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'double_click',
    description: 'Bấm đúp chuột trái tại toạ độ (x, y) trên ảnh chụp màn hình thu nhỏ.',
    risk: 'dynamic',
    parameters: {
      type: 'object',
      properties: {
        x: {
          type: 'number',
          description: 'Toạ độ X trên ảnh màn hình thu nhỏ'
        },
        y: {
          type: 'number',
          description: 'Toạ độ Y trên ảnh màn hình thu nhỏ'
        },
        description: {
          type: 'string',
          description: 'Mô tả thành phần được bấm đúp'
        }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'scroll',
    description: 'Cuộn con lăn chuột trên màn hình. Giá trị âm (ví dụ: -400) để cuộn xuống xem nội dung phía dưới, giá trị dương (ví dụ: 400) để cuộn lên.',
    risk: 'safe',
    parameters: {
      type: 'object',
      properties: {
        amount: {
          type: 'number',
          description: 'Khoảng cách cuộn: số âm để cuộn xuống, số dương để cuộn lên'
        },
        description: {
          type: 'string',
          description: 'Mô tả hướng cuộn màn hình'
        }
      },
      required: ['amount']
    }
  },
  {
    name: 'type_text',
    description: 'Gõ văn bản vào trường đang được trỏ chuột (hỗ trợ tiếng Việt có dấu chuẩn 100%). TUYỆT ĐỐI KHÔNG dùng để gõ mật khẩu, OTP hay mã thẻ ngân hàng.',
    risk: 'dynamic',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Văn bản cần gõ'
        },
        description: {
          type: 'string',
          description: 'Mô tả ô hoặc trường đang gõ vào'
        }
      },
      required: ['text']
    }
  },
  {
    name: 'press_key',
    description: 'Bấm một phím hoặc tổ hợp phím bàn phím (ví dụ: enter, esc, tab, backspace, down, up, ctrl+a, ctrl+c, ctrl+v).',
    risk: 'dynamic',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Tên phím hoặc tổ hợp phím cách nhau bằng dấu cộng'
        },
        description: {
          type: 'string',
          description: 'Mục đích bấm phím'
        }
      },
      required: ['key']
    }
  }
]);

const SENSITIVE_ACTION_PATTERN = /\b(gửi|gui|submit|đăng|dang|post|thanh toán|thanh toan|pay|payment|mua|buy|purchase|xoá|xoa|delete|remove|xác nhận|xac nhan|confirm|đăng nhập|dang nhap|login|signin|mật khẩu|mat khau|password|cài đặt|cai dat|install|setup|settings|registry|powershell|cmd|terminal)\b/i;
const PASSWORD_FIELD_PATTERN = /\b(mật khẩu|mat khau|password|passphrase|pwd|otp|mã xác thực|cvv|cvc|số thẻ|so the|credit card)\b/i;

/**
 * Đánh giá mức độ rủi ro thực tế của một thao tác tool cụ thể
 */
function evaluateActionRisk(toolName, args = {}, options = {}) {
  const tool = NEUTRAL_TOOLS.find((t) => t.name === toolName);
  if (!tool) return { isHighRisk: false, reason: 'unknown' };

  const autoPilot = Boolean(options.autoPilot);

  // 1. Kiểm tra tuyệt đối: Cấm gõ mật khẩu, OTP, thẻ tín dụng
  if (toolName === 'type_text') {
    const text = String(args.text || '');
    const desc = String(args.description || '');
    if (PASSWORD_FIELD_PATTERN.test(text) || PASSWORD_FIELD_PATTERN.test(desc)) {
      return {
        isForbidden: true,
        isHighRisk: true,
        reason: 'password_prohibited',
        dialogTitle: '⛔ Từ chối vì lý do bảo mật',
        description: 'Aura tuyệt đối không gõ mật khẩu, mã OTP hoặc thông tin thẻ ngân hàng để bảo vệ an toàn cho bạn. Xin bạn hãy tự gõ phần này.',
        spokenPrompt: 'Em không được phép gõ mật khẩu hay thông tin bảo mật nhạy cảm. Xin anh hãy tự nhập phần này nhé!'
      };
    }
  }

  // 2. Thao tác điều khiển Computer-Use (mouse_click, double_click, type_text, press_key)
  if (['mouse_click', 'double_click', 'type_text', 'press_key'].includes(toolName)) {
    const desc = String(args.description || args.text || args.key || toolName);
    const isSensitive = SENSITIVE_ACTION_PATTERN.test(desc);

    // Nếu là thao tác nhạy cảm (thanh toán, mua, xoá, đăng, đăng nhập, cài đặt...) -> LUÔN HỎI XÁC NHẬN kể cả khi bật Auto-pilot
    if (isSensitive) {
      return {
        isHighRisk: true,
        reason: 'sensitive_computer_use',
        dialogTitle: '⚠️ Xác nhận thao tác nhạy cảm',
        description: `Aura chuẩn bị thao tác: <b>${escapeHtml(desc)}</b>.<br/><small style="color:#ef4444">Thao tác này liên quan đến gửi/đăng/mua/xoá/đăng nhập/cài đặt nên bắt buộc phải xác nhận.</small>`,
        spokenPrompt: `Em chuẩn bị ${desc}. Thao tác này có tính chất quan trọng, anh có đồng ý không ạ?`
      };
    }

    // Nếu không nhạy cảm: nếu đang bật Auto-pilot thì cho qua, nếu chưa bật thì hỏi xác nhận từng bước
    if (autoPilot) {
      return { isHighRisk: false, reason: 'auto_pilot_permitted' };
    } else {
      return {
        isHighRisk: true,
        reason: 'manual_mode_computer_use',
        dialogTitle: '🖱️ Xác nhận thao tác điều khiển máy',
        description: `Aura chuẩn bị: <b>${escapeHtml(desc)}</b>${args.x !== undefined ? ` tại toạ độ (${args.x}, ${args.y})` : ''}.`,
        spokenPrompt: `Em chuẩn bị ${desc}. Anh có đồng ý không ạ?`
      };
    }
  }

  if (toolName === 'take_screenshot' || toolName === 'scroll') {
    return { isHighRisk: false, reason: 'safe_computer_use' };
  }

  if (toolName === 'run_in_project') {
    const rawCmd = String(args.command || '').trim();
    const rawPath = String(args.path || '').trim();
    const cmdLower = rawCmd.toLowerCase();

    // 1. Chặn cứng các lệnh nguy hiểm (Hard-blocked Commands)
    if (
      cmdLower.includes('format ') ||
      cmdLower.includes('git push') ||
      cmdLower.includes('reg add') ||
      cmdLower.includes('reg delete') ||
      cmdLower.includes('regedit') ||
      cmdLower.includes('del /s /q c:\\windows') ||
      cmdLower.includes('rm -rf /') ||
      cmdLower.includes('rm -rf c:') ||
      cmdLower.includes('.env')
    ) {
      return {
        isForbidden: true,
        isHighRisk: true,
        reason: 'prohibited_system_command',
        dialogTitle: '⛔ Lệnh bị chặn cứng vì lý do an toàn',
        description: `Lệnh chứa thao tác nguy hiểm bị nghiêm cấm: <code>${escapeHtml(rawCmd)}</code>.`,
        spokenPrompt: 'Lệnh này nằm trong danh mục cấm tuyệt đối vì có thể gây ảnh hưởng hệ thống!'
      };
    }

    // 2. Kiểm tra thao tác cài đặt thư viện (npm install, pip install...)
    const isInstallCmd =
      /\b(npm\s+(i|install|add)|yarn\s+add|pnpm\s+(add|i|install)|pip\s+install|dotnet\s+restore)\b/i.test(cmdLower);

    if (isInstallCmd) {
      const cachePath = path.join(path.resolve(__dirname, '..', '..'), 'projects_cache.json');
      let isAlreadyApproved = false;
      try {
        if (fs.existsSync(cachePath)) {
          const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          const resolvedP = rawPath ? path.resolve(rawPath).toLowerCase() : '';
          for (const [pKey, pVal] of Object.entries(cache)) {
            if (path.resolve(pKey).toLowerCase() === resolvedP && pVal.installApproved === true) {
              isAlreadyApproved = true;
              break;
            }
          }
        }
      } catch (_) {}

      if (!isAlreadyApproved) {
        return {
          isHighRisk: true,
          reason: 'install_dependencies_confirmation',
          dialogTitle: '📦 Xác nhận cài đặt thư viện cho dự án',
          description:
            `Aura chuẩn bị chạy lệnh cài đặt gói:<br/>` +
            `• Thư mục: <code>${escapeHtml(rawPath || 'Dự án hiện tại')}</code><br/>` +
            `• Lệnh: <code>${escapeHtml(rawCmd)}</code><br/>` +
            `<small style="color:#38bdf8">Chỉ cần xác nhận 1 lần duy nhất cho mỗi dự án. Các lần sau sẽ tự động chạy.</small>`,
          spokenPrompt: 'Em chuẩn bị cài đặt thư viện cho dự án. Anh có đồng ý không ạ?'
        };
      }
    }

    return { isHighRisk: false, reason: 'safe_project_run' };
  }

  if (toolName === 'run_test') {
    const topicArg = String(args.topic || '').trim();
    const topicsFile = path.join(path.resolve(__dirname, '..', '..'), 'test_topics.json');
    let matchedName = topicArg;
    let cmdStr = '';
    let cwdStr = '';
    try {
      if (fs.existsSync(topicsFile)) {
        const topics = JSON.parse(fs.readFileSync(topicsFile, 'utf8'));
        const found = topics.find(
          (t) =>
            t.id.toLowerCase() === topicArg.toLowerCase() ||
            t.name.toLowerCase().includes(topicArg.toLowerCase()) ||
            (t.keywords && t.keywords.some((k) => topicArg.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(topicArg.toLowerCase())))
        );
        if (found) {
          matchedName = found.name;
          cmdStr = `${found.command} ${found.args.join(' ')}`;
          cwdStr = found.cwd;
        }
      }
    } catch (_) {}

    return {
      isHighRisk: true,
      reason: 'run_test_confirmation',
      dialogTitle: '🧪 Xác nhận thực thi kiểm thử SWT301',
      description:
        `Aura chuẩn bị thực thi bài test: <b>${escapeHtml(matchedName)}</b>.<br/>` +
        `• Thư mục làm việc: <code>${escapeHtml(cwdStr || 'D:\\ảnh\\SWT301')}</code><br/>` +
        `• Lệnh cố định: <code>${escapeHtml(cmdStr || 'node/dotnet ...')}</code><br/>` +
        `<small style="color:#38bdf8">Lệnh chạy độc lập, tuần tự và có giới hạn timeout bảo vệ hệ thống.</small>`,
      spokenPrompt: `Em chuẩn bị chạy bài test ${matchedName}. Anh có đồng ý chạy không ạ?`
    };
  }

  if (toolName === 'close_app') {
    return {
      isHighRisk: true,
      reason: 'close_app',
      dialogTitle: '⚠️ Xác nhận đóng ứng dụng',
      description: `Aura chuẩn bị đóng ứng dụng: <b>${escapeHtml(args.name || '')}</b>. Mọi dữ liệu chưa lưu trong ứng dụng có thể bị mất.`,
      spokenPrompt: `Em chuẩn bị đóng ứng dụng ${args.name || ''}. Anh có chắc chắn muốn đóng không ạ?`
    };
  }

  if (toolName === 'open_url') {
    const rawUrl = String(args.url || '').trim();
    let hostname = '';
    try {
      const parsed = new URL(rawUrl);
      hostname = parsed.hostname.toLowerCase();
    } catch (_) {
      hostname = rawUrl.toLowerCase();
    }

    const isTrusted = TRUSTED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith('.' + d)
    );

    if (!isTrusted) {
      return {
        isHighRisk: true,
        reason: 'untrusted_url',
        dialogTitle: '⚠️ Xác nhận mở liên kết lạ',
        description: `Aura chuẩn bị mở liên kết bên ngoài: <br/><a href="${escapeHtml(rawUrl)}" target="_blank" style="color:#38bdf8;word-break:break-all">${escapeHtml(rawUrl)}</a><br/><small style="color:#94a3b8">Trang web này không nằm trong danh sách tin cậy được thiết lập sẵn.</small>`,
        spokenPrompt: `Liên kết ${hostname || rawUrl} không nằm trong danh sách tin cậy. Anh có đồng ý mở trang này không ạ?`
      };
    }
    return { isHighRisk: false, reason: 'trusted_url' };
  }

  if (toolName === 'open_folder' || toolName === 'open_file') {
    const rawPath = String(args.path || '').trim();
    const isAllowed = isPathInsideAllowedFolders(rawPath);
    if (!isAllowed) {
      const typeLabel = toolName === 'open_folder' ? 'thư mục' : 'file';
      return {
        isHighRisk: true,
        reason: 'outside_allowed_folders',
        dialogTitle: `⚠️ Xác nhận mở ${typeLabel} ngoài danh sách cho phép`,
        description: `Aura chuẩn bị mở ${typeLabel}: <b>${escapeHtml(rawPath)}</b>.<br/><small style="color:#ef4444">Đường dẫn này nằm ngoài các thư mục được phê duyệt trong allowed_folders.json.</small>`,
        spokenPrompt: `Đường dẫn ${rawPath} nằm ngoài danh sách thư mục được cấp phép. Anh có đồng ý mở không ạ?`
      };
    }
    return { isHighRisk: false, reason: 'allowed_folder' };
  }

  if (toolName === 'clipboard_write') {
    const preview = String(args.text || '').substring(0, 120);
    return {
      isHighRisk: true,
      reason: 'clipboard_write',
      dialogTitle: '⚠️ Xác nhận ghi vào Clipboard',
      description: `Aura chuẩn bị ghi nội dung mới vào bộ nhớ đệm (Clipboard):<br/><i>"${escapeHtml(preview)}"${args.text && args.text.length > 120 ? '...' : ''}</i>`,
      spokenPrompt: `Em chuẩn bị ghi nội dung mới vào bộ nhớ tạm (clipboard). Anh có đồng ý không ạ?`
    };
  }

  return { isHighRisk: false, reason: tool.risk };
}

function isPathInsideAllowedFolders(targetPath) {
  if (!targetPath) return false;
  let cleanTarget = String(targetPath).trim().normalize('NFC').replace(/\//g, '\\');
  if (/^[a-zA-Z]:$/.test(cleanTarget)) cleanTarget += '\\';
  const targetLower = cleanTarget.toLowerCase();

  const allowedPath = path.join(path.resolve(__dirname, '..', '..'), 'allowed_folders.json');
  let allowedList = [];
  try {
    if (fs.existsSync(allowedPath)) {
      const raw = fs.readFileSync(allowedPath, 'utf8').replace(/^\uFEFF/, '');
      allowedList = JSON.parse(raw);
    }
  } catch (_) {}

  if (!Array.isArray(allowedList) || allowedList.length === 0) {
    allowedList = ['D:\\AURA_Assistant', 'D:\\'];
  }

  if (allowedList.includes('*')) return true;

  return allowedList.some((folder) => {
    if (folder === '*') return true;
    let cleanAllowed = String(folder || '').trim().normalize('NFC').replace(/\//g, '\\');
    if (/^[a-zA-Z]:$/.test(cleanAllowed)) cleanAllowed += '\\';
    const normAllowed = cleanAllowed.toLowerCase();
    if (targetLower === normAllowed) return true;
    if (normAllowed.endsWith('\\')) {
      return targetLower.startsWith(normAllowed);
    } else {
      return targetLower.startsWith(normAllowed + '\\');
    }
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[c]));
}

/**
 * Chuyển schema sang chuẩn Gemini v1beta functionDeclarations
 */
function convertToolsForGemini(tools = NEUTRAL_TOOLS) {
  return tools.map((t) => {
    const properties = {};
    const rawProps = (t.parameters && t.parameters.properties) || {};
    for (const [k, v] of Object.entries(rawProps)) {
      properties[k] = {
        type: String(v.type || 'STRING').toUpperCase(),
        description: v.description || ''
      };
    }
    return {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'OBJECT',
        properties,
        required: t.parameters?.required || []
      }
    };
  });
}

/**
 * Chuyển schema sang chuẩn Claude Anthropic tool definitions
 */
function convertToolsForClaude(tools = NEUTRAL_TOOLS) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: t.parameters?.properties || {},
      required: t.parameters?.required || []
    }
  }));
}

/**
 * Chuyển schema sang chuẩn OpenAI Chat Completions (dùng chung cho Groq, OpenRouter...)
 */
function convertToolsForOpenAI(tools = NEUTRAL_TOOLS) {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: {
        type: 'object',
        properties: t.parameters?.properties || {},
        required: t.parameters?.required || []
      }
    }
  }));
}

module.exports = {
  TRUSTED_DOMAINS,
  UNSUPPORTED_ACTIONS_NOTICE,
  NEUTRAL_TOOLS,
  evaluateActionRisk,
  convertToolsForGemini,
  convertToolsForClaude,
  convertToolsForOpenAI
};
